'use strict';

const { Adapter, Device, Property, Event, Database } = require('gateway-addon');
const manifest = require('./manifest.json');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const dnssd = require('dnssd');
const { connect } = require('mqtt');

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
        this.server = new dnssd.Browser(new dnssd.ServiceType('_http._tcp'));
        this.server.on('serviceUp', (service) => {
            if(this.discoveryCallback && service.name.startsWith('DINGZ')) {
                this.discoveryCallback({
                    mac: service.txt.mac,
                    address: service.addresses[0],
                });
            }
        });
        this.server.start();
    }
    destroy() {
        this.server.stop();
    }
}

class DingzMQTT {
    constructor(adapter) {
        this.adapter = adapter;
        this.connect();
    }

    async connect() {
        const db = new Database("dingz-adapter");
        await db.open();
        const { host = 'localhost', port = 1883 } = await db.loadConfig();
        this.address = `mqtt://${host}:${port}`;
        this.client = connect(this.address);

        this.client.on('connect', () => {
            this.client.subscribe('dingz/#');
        });

        this.client.on('error', (error) => {
            console.error(error);
        });

        this.client.on('message', (topic, message) => {
            const [dingzTopic, dingzId, ...localPath] = topic.split('/');
            if (dingzTopic !== "dingz") {
                return;
            }
            const device = this.adapter.getDevice(`dingz-${dingzId}`);
            let parsedMessage;
            let messageString = message.toString('ascii');
            try {
                // Workaround invalid JSON
                if(topic.endsWith("state/thermostat")) {
                    messageString = messageString.replace('"target:"', '"target":');
                }
                parsedMessage = JSON.parse(messageString);
            }
            catch(error) {
                if(['s', 'ss', 'n'].includes(messageString)) {
                    parsedMessage = messageString !== 'n';
                }
                else if(['p', 'h', 'r'].includes(messageString) || messageString.startsWith('m')) {
                    parsedMessage = messageString;
                }
                else {
                    console.error(error, "while parsing", topic, messageString);
                    return;
                }
            }
            if (!device) {
                if (localPath[0] === 'announce') {
                    this.adapter.handleDiscovery({
                        mac: dingzId.toUpperCase(),
                        address: parsedMessage.ip
                    });
                }
                return;
            }
            device.mqttEvent(localPath.join('/'), parsedMessage);
        });
    }

    sendEvent(dingzId, localPath, message) {
        return new Promise((resolve, reject) => {
            this.client.publish(`dingz/${dingzId}/${localPath}`, message, (error) => {
                if(error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            });
        });
    }

    destroy() {
        this.client.end();
    }
}

class BasicDingzProperty extends Property {
    constructor(device, name, spec, ...args) {
        super(device, name, spec, ...args);
        this.visible = spec.visible !== undefined ? spec.visible : true;
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
            const action = value ? 1 : 0;
            await this.device.sendMqttEvent("command/led", { on: action });
        }
        else if(this.name === 'ledColor') {
            if (!value) {
                return;
            }
            const r = parseInt(value.slice(1, 3), 16);
            const g = parseInt(value.slice(3, 5), 16);
            const b = parseInt(value.slice(5), 16);
            await this.device.sendMqttEvent("command/led", { r, g, b });
        }
        else if(this.name === 'targetTemperature') {
            const mode = await this.device.getProperty('thermostatMode');
            await this.device.apiCall(`thermostat/${mode}?temp=${value}`, 'POST');
        }
        else if(this.name === 'thermostatMode') {
            const targetTemperature = await this.device.getProperty('targetTemperature');
            await this.device.apiCall(`thermostat/${value ? 'on' : 'off'}?temp=${targetTemperature}`, 'POST');
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
            await this.device.sendMqttEvent(`command/motor/${indexNumber - 1}`, {position: blindValue, lamella: lamellaValue });
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
        this.configureMqtt();
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
                }),
            this.apiCall('outputs')
                .then((outputs) => {
                    const thermostatOutput = outputs.find((output) => output && output.type === "heating_valve");
                    if (thermostatOutput && thermostatOutput.enable) {
                        this.thermostatOutput = thermostatOutput.ph_out_id;
                    }
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
            let actionMotion = NaN;
            if(actionName === "stop") {
                actionMotion = 0;
            }
            else if(actionName === "up") {
                actionMotion = 1;
            }
            else if(actionName === "down") {
                actionMotion = 2;
            }
            else {
                console.error("Unknown shade action", action.name);
                return;
            }
            return this.sendMqttEvent(`command/motor/${index}`, { motion: actionMotion });
        }
        if(action.name.startsWith('dimmer')) {
            return this.sendMqttEvent(`command/light/${parseInt(action.name.slice(6,7)) - 1}`, {turn: "toggle"});
        }
    }

    configureMqtt() {
        return this.apiCall('services_config', 'POST', JSON.stringify({
            mqtt: {
                uri: this.adapter.mqtt.address,
                enable: true,
                "server.crt": null
            }
        }));
    }

    mqttEvent(path, message) {
        const [deviceType, event, ...details] = path.split('/');
        if(deviceType === "online") {
            this.connectedNotify(message);
            return;
        }
        if(deviceType === "announce") {
            this.address = message.ip;
            this.deviceType = message.model;
            return;
        }
        if(deviceType === "last_alive") {
            return;
        }
        this.deviceType = deviceType;
        switch(event) {
            case "sensor":
                switch(details[0]) {
                    case "temperature":
                        this.findProperty("temperature")?.setCachedValueAndNotify(message);
                        break;
                    case "light":
                        this.findProperty("lightLevel")?.setCachedValueAndNotify(message);
                        break;
                }
                break;
            case "power":
                const index = parseInt(details[1], 10) + 1;
                switch(details[0]) {
                    case "motor":
                        this.findProperty(`shade${index}Power`)?.setCachedValueAndNotify(message);
                        break;
                    case "light":
                        this.findProperty(`dimmer${index}Power`)?.setCachedValueAndNotify(message);
                        break;
                }
                break;
            case "energy":
                switch(details[0]) {
                    case "motor":
                    case "light":
                        //TODO no properties for these, not even sure what unit this is?
                        break;
                }
                break;
            case "state":
                switch(details[0]) {
                    case "light": {
                        const index = parseInt(details[1], 10) + 1;
                        this.findProperty(`dimmer${index}`)?.setCachedValueAndNotify(message.turn === "off");
                        this.findProperty(`dimmer${index}Brightness`)?.setCachedValueAndNotify(message.brightness);
                        break;
                    }
                    case "thermostat":
                        this.findProperty('thermostatMode')?.setCachedValueAndNotify(message.status);
                        this.findProperty('thermostatState')?.setCachedValueAndNotify(message.status === 'on' ? message.mode : 'off');
                        this.findProperty('targetTemperature')?.setCachedValueAndNotify(message.target);
                        break;
                    case "motor": {
                        const index = parseInt(details[1], 10) + 1;
                        this.findProperty(`shade${index}`)?.setCachedValueAndNotify(message.position);
                        this.findProperty(`shade${index}Lamella`)?.setCachedValueAndNotify(message.lamella);
                        break;
                    }
                    case "led":
                        this.findProperty('led')?.setCachedValueAndNotify(message.on === 1);
                        this.findProperty('ledColor')?.setCachedValueAndNotify(`#${message.r.toString(16).padStart(2, '0')}${message.g.toString(16).padStart(2, '0')}${message.b.toString(16).padStart(2, '0')}`);
                        break;
                    case "input":
                        console.warn("unhandled state info for input", details[1], message);
                        break;
                }

                break;
            case "event":
                switch(details[0]) {
                    case "button": {
                        const keyID = `key${parseInt(details[1], 10) + 1}`;
                        if (keyID === "key5") {
                            console.warn("Input as button not yet supported");
                            return;
                        }
                        switch(message) {
                            case "p":
                                this.findProperty(keyID).setCachedValueAndNotify(true);
                                break;
                            case "m1":
                                this.eventNotify(new Event(this, `${keyID}single`));
                                this.findProperty(keyID).setCachedValueAndNotify(false);
                                break;
                            case "m2":
                                this.eventNotify(new Event(this, `${keyID}double`));
                                this.findProperty(keyID).setCachedValueAndNotify(false);
                                break;
                            case "m3":
                                this.eventNotify(new Event(this, `${keyID}tripple`));
                                this.findProperty(keyID).setCachedValueAndNotify(false);
                                break;
                            case "m2":
                                this.eventNotify(new Event(this, `${keyID}quadruple`));
                                this.findProperty(keyID).setCachedValueAndNotify(false);
                                break;
                            case "h":
                                break;
                            case "r":
                                this.eventNotify(new Event(this, `${keyID}long`));
                                this.findProperty(keyID).setCachedValueAndNotify(false);
                                break;
                            default:
                                if (message.startsWith("m")) {
                                    this.findProperty(keyID).setCachedValueAndNotify(false);
                                }
                                else {
                                    console.warn("unhandled button event", message, keyID);
                                }
                                break;
                        }
                        break;
                    }
                    case "pir":
                        if(details[1] === "0") {
                            this.findProperty("motion")?.setCachedValueAndNotify(message);
                        }
                        break;
                }
                break;
            case "command":
                // Ignore commands, those are for the dingz to consume.
                break;
            default:
                console.warn("Unhandled event", path, message);
        }
    }

    async sendMqttEvent(path, message) {
        if(!this.deviceType) {
            console.error("Device type not configured, can't publish MQTT messages for device.");
            return;
        }
        return this.adapter.mqtt.sendEvent(this.mac.toLowerCase(), `${this.deviceType}/${path}`, JSON.stringify(message));
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
        lamellaProperty.visible = shadeConfig.type === 'blind';
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
            const visible = config.active && config.type == "light";
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
        if (!state) {
            return;
        }
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
            this.findProperty(`dimmer${this.thermostatOutput + 1}Power`).setCachedValueAndNotify(state.sensors.power_outputs[this.thermostatOutput].value);
        }
    }
}

class DingzAdapter extends Adapter {
    constructor(addonManager) {
        super(addonManager, manifest.id, manifest.id);
        addonManager.addAdapter(this);
        this.mqtt = new DingzMQTT(this);
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
        super.handleDeviceAdded(device);
    }

    handleDeviceRemoved(device) {
        super.handleDeviceRemoved(device);
    }

    unload() {
        if(this.discovery) {
            this.discovery.destroy();
            delete this.discovery;
        }
        this.mqtt.destroy();

        return Promise.resolve();
    }
}

module.exports = (addonManager) => {
    new DingzAdapter(addonManager);
};
