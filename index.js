'use strict';

const { Adapter, Device, Property, Event, Database } = require('gateway-addon');
const manifest = require('./manifest.json');
const dgram = require('dgram');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const WebEventEndpoint = require('./events');

const DINGZ_DISCOVERY_PORT = 7979;
const DISCOVERY_MESSAGE_BYTES = 8;
const DINGZ_TYPE = 108;
const MAC_BYTES = [ 0, 1, 2, 3, 4, 5 ];
const DEFAULT_POLL_INTERVAL_S = 3;
const THERMOSTAT_STATE_TO_MODE = {
    heating: 'heat',
    cooling: 'cool'
};

// based on https://www.rapidtables.com/convert/color/hsv-to-rgb.html
function hsv2rgb(hsv) {
    const [h, s, v] = hsv.split(';');
    const ha = Number.parseInt(h);
    const sa = Number.parseInt(s) / 100;
    const va = Number.parseInt(v) / 100;
    const c = va * sa;
    const x = c * (1 - Math.abs((ha / 60) % 2 - 1));
    const m = va - c;
    let ra = 0, ga = 0, ba = 0;
    if (ha < 60) {
        ra = c;
        ga = x;
    } else if(ha < 120) {
        ra = x;
        ga = c;
    } else if(ha < 180) {
        ga = c;
        ba = x;
    } else if(ha < 240) {
        ga = x;
        ba = c;
    } else if(ha < 300) {
        ra = x;
        ba = c;
    } else {
        ra = c;
        ba = x;
    }
    const r = Math.floor((ra + m) * 255);
    const g = Math.floor((ga + m) * 255);
    const b = Math.floor((ba + m) * 255);
    return (r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0')).toUpperCase();
}

class DingzDiscovery {
    constructor(discoveryCallback) {
        this.discoveryCallback = discoveryCallback;
        this.server = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        this.server.bind(DINGZ_DISCOVERY_PORT);
        this.server.on('message', (msg, remoteInfo) => {
            if(remoteInfo.size === DISCOVERY_MESSAGE_BYTES) {
                const type = msg.readUInt8(6);
                if (type === DINGZ_TYPE) {
                    const mac = MAC_BYTES.map((byteIndex) => msg.readUInt8(byteIndex).toString(16)).join('');
                    if(this.discoveryCallback) {
                        this.discoveryCallback({
                            mac,
                            address: remoteInfo.address,
                        });
                    }
                }
            }
        });
    }
    destroy() {
        this.server.close();
    }
}

const DevicePoller = {
    timer: null,
    devices: new Set(),
    async getPollInterval() {
        const db = new Database(manifest.name);
        await db.open();
        const { poll_interval = DEFAULT_POLL_INTERVAL_S } = await db.loadConfig();
        return poll_interval * 1000;
    },
    addDevice(device) {
        this.devices.add(device);
        if(!this.timer) {
            this.getPollInterval()
                .then((interval) => {
                    this.timer = setInterval(() => this.notifyDevices(), interval);
                })
                .catch(console.error);
        }
    },
    destroy() {
        if(this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.devices = new Set();
    },
    removeDevice(device) {
        this.devices.delete(device);
        if(this.devices.size === 0) {
            this.destroy();
        }
    },
    notifyDevices() {
        for(const device of this.devices) {
            device.poll();
        }
    }
};

class BasicDingzProperty extends Property {
    constructor(...args) {
        super(...args);
        this.visible = true;
    }

    asDict() {
        const dict = super.asDict();
        dict.visible = this.visible;
        return dict;
    }
}

class DingzProperty extends BasicDingzProperty {
    async setValue(value) {
        if(this.name === 'led') {
            const action = value ? 'on' : 'off';
            const params = new URLSearchParams();
            params.append('action', action);
            await this.device.apiCall('led/set', 'POST', params);
        }
        else if(this.name === 'ledColor') {
            const params = new URLSearchParams();
            params.append('color', value.slice(1).toUpperCase());
            params.append('mode', 'rgb');
            await this.device.apiCall('led/set', 'POST', params);
        }
        else if(this.name === 'targetTemperature') {
            const mode = (await this.device.getProperty('thermostatMode')) !== 'off';
            await this.device.apiCall(`thermostat?target_temp=${value}&enable=${mode}`, 'POST');
        }
        else if(this.name === 'thermostatMode') {
            const targetTemperature = await this.device.getProperty('targetTemperature');
            await this.device.apiCall(`thermostat?target_temp=${targetTemperature}&enable=${value !== 'off'}`, 'POST');
            //TODO support switching between heating and cooling?
        }
        else if(this.name.startsWith('shade')) {
            let index = this.name.slice(5);
            let blindValue = value;
            let lamellaValue;
            if(this.name.endsWith('Lamella')) {
                index = index.slice(0, -7);
                lamellaValue = value;
                try {
                    blindValue = await this.device.getProperty(this.name.slice(0, -7));
                }
                catch(error) {
                    blindValue = 100;
                }
            }
            else {
                try {
                    lamellaValue = await this.device.getProperty(this.name + 'Lamella');
                }
                catch(error) {
                    lamellaValue = 100;
                }
            }
            const indexNumber = parseInt(index);
            await this.device.apiCall(`shade/${indexNumber - 1}?blind=${blindValue}&lamella=${lamellaValue}`, 'POST');
        }
        else if(this.name.startsWith('dimmer')) {
            //TODO
        }
        return super.setValue(value);
    }
}

class Dingz extends Device {
    constructor(adapter, deviceSpec) {
        super(adapter, `dingz-${deviceSpec.mac.toLowerCase()}`);
        this.address = deviceSpec.address;
        this.mac = deviceSpec.mac.toUpperCase();
        this.connected = true;
        this.setDescription('Dingz Puck');
        this['@type'] = [
            'ColorControl',
            'PushButton',
            'TemperatureSensor'
        ];
        Promise.all([
            this.apiCall('system_config')
                .then((systemConfig) => {
                    this.setTitle(`${systemConfig.room_name} - ${systemConfig.dingz_name}`);
                }),
            this.apiCall('device')
                .then((info) => {
                    const deviceInfo = info[this.mac];
                    const dipConfig = deviceInfo.dip_config;
                    this.shade1 = dipConfig === 0 || dipConfig === 2;
                    this.shade2 = dipConfig <= 1;
                    this.dimmerGroup1 = dipConfig === 1 || dipConfig === 3;
                    this.dimmerGroup2 = dipConfig >= 2;
                    this.motionSensor = deviceInfo.has_pir;
                }),
            this.apiCall('thermostat')
                .then((thermostatState) => {
                    this.thermostat = thermostatState.active;
                    this.thermostatOutput = thermostatState.out;
                })
        ])
            .then(() => {
                if(this.motionSensor) {
                    this['@type'].push('MotionSensor');
                }
                if(this.shade1 || this.shade2) {
                    this['@type'].push('EnergyMonitor');
                    // no official shades capability :(
                    this['@type'].push('Shade');
                    //TODO has lamella cap?
                }
                if(this.dimmerGroup1 || this.dimmerGroup2) {
                    this['@type'].push('Light');
                    if(!this['@type'].includes('EnergyMonitor')) {
                        this['@type'].push('EnergyMonitor');
                    }
                }
                if(this.thermostat) {
                    this['@type'].push('Thermostat');
                    if(!this['@type'].includes('EnergyMonitor')) {
                        this['@type'].push('EnergyMonitor');
                    }
                }

                this.addProperty(new DingzProperty(this, 'led', {
                    title: 'LED',
                    type: 'boolean',
                    '@type': 'OnOffProperty'
                }));
                this.addProperty(new DingzProperty(this, 'ledColor', {
                    title: 'LED Color',
                    type: 'string',
                    '@type': 'ColorProperty'
                }));
                this.addProperty(new BasicDingzProperty(this, 'lightLevel', {
                    title: 'Brightness',
                    type: 'integer',
                    unit: 'lux',
                    minimum: 0,
                    readOnly: true
                }));
                this.addProperty(new BasicDingzProperty(this, 'temperature', {
                    title: 'Temperature',
                    type: 'number',
                    unit: 'degree celsius',
                    readOnly: true,
                    '@type': 'TemperatureProperty'
                }));

                this.addKey(1);
                this.addKey(2);
                this.addKey(3);
                this.addKey(4);

                if(this.dimmerGroup1) {
                    this.addDimmer(1);
                    this.addDimmer(2);
                }
                if(this.dimmerGroup2) {
                    this.addDimmer(3);
                    this.addDimmer(4);
                }

                if(this.shade1) {
                    this.addShade(1);
                }
                if(this.shade2) {
                    this.addShade(2);
                }
                if(this.motionSensor) {
                    this.addProperty(new BasicDingzProperty(this, 'motion', {
                        title: 'Motion',
                        type: 'boolean',
                        readOnly: true,
                        '@type': 'MotionProperty',
                    }));
                }
                if(this.thermostat) {
                    this.addProperty(new DingzProperty(this, 'targetTemperature', {
                        title: 'Target Temperature',
                        type: 'number',
                        unit: 'degree celsius',
                        '@type': 'TargetTemperatureProperty',
                        minimum: -55,
                        maximum: 125
                    }));
                    this.addProperty(new DingzProperty(this, 'thermostatMode', {
                        title: 'Thermostat Mode',
                        type: 'string',
                        enum: [
                            'off',
                            'heat',
                            'cool'
                        ],
                        '@type': 'ThermostatModeProperty'
                    }));
                    this.addProperty(new BasicDingzProperty(this, 'thermostatState', {
                        title: 'Thermostat State',
                        type: 'string',
                        enum: [
                            'off',
                            'heating',
                            'cooling'
                        ],
                        readOnly: true,
                        '@type': 'HeatingCoolingProperty'
                    }));
                    const dimmerID = `dimmer${this.thermostatOutput + 1}`;
                    if(!this.hasProperty(dimmerID + 'Power')) {
                        this.addProperty(new BasicDingzProperty(this, dimmerID + 'Power', {
                            title: 'Thermostat Valve Power',
                            type: 'number',
                            unit: 'watt',
                            '@type': 'InstantaneousPowerProperty',
                            readOnly: true,
                            visible: true,
                            minimum: 0,
                            maximum: 300
                        }));
                    }
                    else {
                        this.findProperty(dimmerID + 'Power').title = 'Thermostat Valve Power';
                    }
                }
                const detailPromises = [
                    undefined,
                    undefined
                ];
                if(this.shade1 || this.shade2) {
                    detailPromises[0] = this.apiCall('blind_config');
                }
                if(this.dimmerGroup1 || this.dimmerGroup2) {
                    detailPromises[1] = this.apiCall('dimmer_config');
                }
                detailPromises.push(this.registerEventListener());
                //TODO LED actions (toggle, blink)
                return Promise.all(detailPromises);
            })
            .then(([ blindConfig, dimmerConfig ] = []) => {
                if(blindConfig) {
                    if(this.shade1) {
                        this.setShadeConfig(1, blindConfig);
                    }
                    if(this.shade2) {
                        this.setShadeConfig(2, blindConfig);
                    }
                }
                if(dimmerConfig) {
                    if(this.dimmerGroup1) {
                        this.setDimmerConfig(1, dimmerConfig);
                        this.setDimmerConfig(2, dimmerConfig);
                    }
                    if(this.dimmerGroup2) {
                        this.setDimmerConfig(3, dimmerConfig);
                        this.setDimmerConfig(4, dimmerConfig);
                    }
                }
                this.adapter.handleDeviceAdded(this);
            });
    }

    get links() {
        return [
            {
                rel: 'alternate',
                mediaType: 'text/html',
                href: `http://${this.address}/index.html`
            },
        ];
    }

    set links(val) {}

    asDict() {
        const dict = super.asDict();

        for(const [key, property] of Object.entries(dict.properties)) {
            if(property.visible === false) {
                delete dict.properties[key];
            }
        }

        for(const [key, action] of Object.entries(dict.actions)) {
            if(action.visible === false) {
                delete dict.actions[key];
            }
        }

        return dict;
    }

    async performAction(action) {
        if(action.name.startsWith('shade')) {
            const index = parseInt(action.name.slice(5, 6)) - 1;
            const actionName = action.name.slice(6);
            return this.apiCall(`shade/${index}/${actionName}`, 'POST');
        }
        if(action.name.startsWith('dimmer')) {
            //TODO toggle action
        }
    }

    async apiCall(path, method = 'GET', body) {
        if(!this.address) {
            console.warn('IP not set for', this.id);
            return;
        }
        try {
            const response = await fetch(`http://${this.address}/api/v1/${path}`, {
                method,
                redirect: 'follow',
                body
            });
            if(response.ok && response.status < 400) {
                if(response.status !== 204 && method !== 'POST') {
                    return response.json();
                }
            }
            else {
                const error = await response.text();
                throw new Error(`${response.status}: ${error}`);
            }
        }
        catch(error) {
            if(error.type === 'system' && (error.code === 'ETIMEDOUT' || error.code === 'EHOSTUNREACH')) {
                this.connectedNotify(false);
            }
            else {
                throw error;
            }
        }
    }

    addShade(index) {
        //TODO should have target position and current position.
        this.addProperty(new DingzProperty(this, `shade${index}`, {
            title: `Shade ${index} Position`,
            type: 'integer',
            minimum: 0,
            maximum: 100,
            '@type': 'LevelProperty',
            unit: 'percent'
        }));
        this.addProperty(new DingzProperty(this, `shade${index}Lamella`, {
            title: `Shade ${index} Lamella`,
            type: 'integer',
            minimum: 0,
            maximum: 100,
            '@type': 'LevelProperty',
            unit: 'percent'
        }));
        this.addProperty(new BasicDingzProperty(this, `shade${index}Power`, {
            title: `Shade ${index} Power`,
            type: 'number',
            unit: 'watt',
            '@type': 'InstantaneousPowerProperty',
            readOnly: true,
            minimum: 0,
            maximum: 300
        }));
        this.addAction(`shade${index}up`, {
            title: `Shade ${index} up`
        });
        this.addAction(`shade${index}down`, {
            title: `Shade ${index} down`
        });
        this.addAction(`shade${index}stop`, {
            title: `Shade ${index} stop`
        });
        //TODO initialize action?
    }

    setShadeConfig(index, config) {
        const shadeConfig = config.blinds[index - 1];
        const lamellaProperty = this.findProperty(`shade${index}Lamella`);
        lamellaProperty.visible = shadeConfig.type === 'lamella_90';
        const levelProperty = this.findProperty(`shade${index}`);
        levelProperty.minimum = shadeConfig.min_value;
        levelProperty.maximum = shadeConfig.max_value;
        if(shadeConfig.name) {
            levelProperty.title = shadeConfig.name;
            lamellaProperty.title = `${shadeConfig.name} Lamella`;
            this.findProperty(`shade${index}Power`).title = `${shadeConfig.name} Power`;
            this.actions.get(`shade${index}up`).title = `${shadeConfig.name} up`;
            this.actions.get(`shade${index}down`).title = `${shadeConfig.name} down`;
            this.actions.get(`shade${index}stop`).title = `Stop ${shadeConfig.name}`;
        }
    }

    addDimmer(index) {
        const dimmerID = `dimmer${index}`;
        const visible = (index - 1) !== this.thermostatOutput;
        this.addProperty(new DingzProperty(this, dimmerID, {
            title: `Dimmer ${index}`,
            type: 'boolean',
            '@type': 'OnOffProperty',
            visible
        }));
        this.addProperty(new DingzProperty(this, dimmerID + 'Brightness', {
            title: `Dimmer ${index} Brightness`,
            type: 'integer',
            minimum: 0,
            maximum: 100,
            unit: 'percent',
            '@type': 'BrightnessProperty',
            visible
        }));
        this.addProperty(new BasicDingzProperty(this, dimmerID + 'Power', {
            title: `Dimmer ${index} Power`,
            type: 'number',
            unit: 'watt',
            '@type': 'InstantaneousPowerProperty',
            readOnly: true,
            visible: true,
            minimum: 0,
            maximum: 300
        }));
        if(visible) {
            this.addAction(dimmerID + 'toggle', {
                '@type': 'ToggleAction',
                title: `Toggle dimmer ${index}`
            });
        }
    }

    setDimmerConfig(index, dimmerConfig) {
        if(index - 1 !== this.thermostatOutput) {
            const config = dimmerConfig.dimmers[index - 1];
            const visible = config.output !== 'not_connected';
            const dimmerID = `dimmer${index}`;
            const dimmerProperty = this.findProperty(dimmerID);
            const dimmerBrightnessProperty = this.findProperty(dimmerID + 'Brightness');
            const dimmerPowerProperty = this.findProperty(dimmerID + 'Power');
            const toggleAction = this.actions.get(dimmerID + 'toggle');
            dimmerProperty.visible = visible;
            dimmerBrightnessProperty.visible = visible;
            dimmerPowerProperty.visible = visible;
            toggleAction.visible = visible;
            if(config.name) {
                dimmerProperty.title = config.name;
                dimmerBrightnessProperty.title = `${config.name} Brightness`;
                dimmerPowerProperty.title = `${config.name} Power`;
                toggleAction.title = `Toggle ${config.name}`;
            }
            if(!visible) {
                this.actions.delete(dimmerID + 'toggle');
            }
        }
    }

    addKey(index) {
        const keyID = `key${index}`;
        this.properties.set(keyID, new BasicDingzProperty(this, keyID, {
            title: `Key ${index}`,
            type: 'boolean',
            readOnly: true,
            '@type': 'PushedProperty'
        }));
        this.addEvent(keyID + 'single', {
            '@type': 'PressedEvent',
            title: `Key ${index} single press`
        });
        this.addEvent(keyID + 'double', {
            '@type': 'DoublePressedEvent',
            title: `Key ${index} double press`
        });
        this.addEvent(keyID + 'tripple', {
            title: `Key ${index} tripple press`
        });
        this.addEvent(keyID + 'quadruple', {
            title: `Key ${index} quadruple press`
        });
        this.addEvent(keyID + 'long', {
            '@type': 'LongPressedEvent',
            title: `Key ${index} long press`
        });
    }

    async registerEventListener() {
        const callbackUrl = await WebEventEndpoint.addDevice(this);
        console.log(callbackUrl);
        await this.apiCall('action/generic/generic', 'POST', callbackUrl);
        // calls that don't fully support being generic yet
        await this.apiCall('action/btn1/begin', 'POST', callbackUrl + `?index=1&action=begin&mac=${this.mac}`);
        await this.apiCall('action/btn1/end', 'POST', callbackUrl + `?index=1&action=end&mac=${this.mac}`);
        await this.apiCall('action/btn2/begin', 'POST', callbackUrl + `?index=2&action=begin&mac=${this.mac}`);
        await this.apiCall('action/btn2/end', 'POST', callbackUrl + `?index=2&action=end&mac=${this.mac}`);
        await this.apiCall('action/btn3/begin', 'POST', callbackUrl + `?index=3&action=begin&mac=${this.mac}`);
        await this.apiCall('action/btn3/end', 'POST', callbackUrl + `?index=3&action=end&mac=${this.mac}`);
        await this.apiCall('action/btn4/begin', 'POST', callbackUrl + `?index=4&action=begin&mac=${this.mac}`);
        await this.apiCall('action/btn4/end', 'POST', callbackUrl + `?index=4&action=end&mac=${this.mac}`);
    }

    handleGenericEvent(index, action) {
        const indexNumber = parseInt(index);
        if(indexNumber <= 4) {
            const keyID = `key${index}`;
            if(action === '1') {
                this.eventNotify(new Event(this, keyID + 'single'));
            }
            else if(action === '2') {
                this.eventNotify(new Event(this, keyID + 'double'))
            }
            else if(action === '3') {
                this.eventNotify(new Event(this, keyID + 'long'))
            }
            else if(action === '20') {
                this.eventNotify(new Event(this, keyID + 'tripple'));
            }
            else if(action === '21') {
                this.eventNotify(new Event(this, keyID + 'quadruple'));
            }
            else if(action === '8' || action === 'begin') {
                this.findProperty(keyID).setCachedValueAndNotify(true);
            }
            else if(action === '9' || action === 'end') {
                this.findProperty(keyID).setCachedValueAndNotify(false);
            }
        }
        else if(indexNumber === 5) {
            if(action === '8') {
                this.findProperty('motion').setCachedValueAndNotify(true);
            }
            else if(action === '9') {
                this.findProperty('motion').setCachedValueAndNotify(false);
            }
        }
        else {
            //TODO input
        }
    }

    updateFromDiscovery(address) {
        this.connectedNotify(true);
        if(address && !address.includes(':')) {
            this.address = address;
        }
    }

    connectedNotify(state) {
        super.connectedNotify(state);
        this.connected = state;
    }

    async poll() {
        if(!this.connected) {
            return;
        }
        const state = await this.apiCall('state');
        if(state.sensors.brightness !== null) {
            this.findProperty('lightLevel').setCachedValueAndNotify(state.sensors.brightness);
        }
        if(state.sensors.hasOwnProperty('room_temperature')) {
            this.findProperty('temperature').setCachedValueAndNotify(state.sensors.room_temperature);
        }
        this.findProperty('led').setCachedValueAndNotify(state.led.on);
        const color = state.led.mode === 'hsv' ? hsv2rgb(state.led.hsv) : state.led.rgb;
        this.findProperty('ledColor').setCachedValueAndNotify(`#${color}`);

        for(const dimmer of state.dimmers) {
            if((dimmer.index.absolute > 1 && this.dimmerGroup2) || (dimmer.index.absolute <= 1 && this.dimmerGroup1)) {
                const dimmerID = `dimmer${dimmer.index.absolute + 1}`;
                this.findProperty(dimmerID).setCachedValueAndNotify(dimmer.on);
                this.findProperty(dimmerID + 'Brightness').setCachedValueAndNotify(dimmer.value);
                this.findProperty(dimmerID + 'Power').setCachedValueAndNotify(state.sensors.power_outputs[dimmer.index.absolute].value);
            }
        }

        for(const blind of state.blinds) {
            if((blind.index.absolute === 0 && this.shade1) || (blind.index.absolute === 1 && this.shade2)) {
                const shadeID = `shade${blind.index.absolute + 1}`;
                this.findProperty(shadeID).setCachedValueAndNotify(blind.position);
                this.findProperty(shadeID + 'Lamella').setCachedValueAndNotify(blind.lamella);
                const baseIndex = blind.index.absolute * 2;
                const motor1Power = state.sensors.power_outputs[baseIndex].value;
                const motor2Power = state.sensors.power_outputs[baseIndex + 1].value;
                this.findProperty(shadeID + 'Power').setCachedValueAndNotify(motor1Power || motor2Power);
            }
        }

        if(state.thermostat.active && this.thermostat) {
            const targetTempProp = this.findProperty('targetTemperature');
            targetTempProp.setCachedValueAndNotify(state.thermostat.target_temp);
            targetTempProp.minimum = state.thermostat.min_target_temp;
            targetTempProp.maximum = state.thermostat.max_target_temp;
            const thermostatMode = state.thermostat.enabled ? THERMOSTAT_STATE_TO_MODE[state.thermostat.mode] : 'off';
            this.findProperty('thermostatMode').setCachedValueAndNotify(thermostatMode);
            const thermostatState = state.thermostat.on ? state.thermostat.mode : 'off';
            this.findProperty('thermostatState').setCachedValueAndNotify(thermostatState);
            this.findProperty(`dimmer${state.thermostat.out + 1}Power`).setCachedValueAndNotify(state.sensors.power_outputs[state.thermostat.out].value);

        }
    }
}

class DingzAdapter extends Adapter {
    constructor(addonManager) {
        super(addonManager, manifest.id, manifest.id);
        addonManager.addAdapter(this);

        this.startDiscovery();
    }

    handleDiscovery(deviceSpec) {
        const deviceId = `dingz-${deviceSpec.mac.toLowerCase()}`;
        if (this.devices.hasOwnProperty(deviceId)) {
            this.getDevice(deviceId).updateFromDiscovery(deviceSpec.address);
            return;
        }

        new Dingz(this, deviceSpec);
    }

    startDiscovery() {
        this.discovery = new DingzDiscovery(this.handleDiscovery.bind(this));
    }

    handleDeviceAdded(device) {
        DevicePoller.addDevice(device);
        super.handleDeviceAdded(device);
    }

    handleDeviceRemoved(device) {
        WebEventEndpoint.removeDevice(device);
        DevicePoller.removeDevice(device);
        super.handleDeviceRemoved(device);
    }

    unload() {
        if(this.discovery) {
            this.discovery.destroy();
            delete this.discovery;
        }
        DevicePoller.destroy();
        WebEventEndpoint.destroy();

        return Promise.resolve();
    }
}

module.exports = (addonManager) => {
    new DingzAdapter(addonManager);
};
