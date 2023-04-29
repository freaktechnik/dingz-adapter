'use strict';

const express = require('express');
const os = require('os');
const { v4: uuid } = require('uuid');
const EVENT_LISTENER_ID = Symbol('Event listener ID');

const WebEventEndpoint = {
    listeners: new Map(),
    async addDevice(device) {
        if(!this.app) {
            await this.startServer();
        }
        const baseAddress = this.getHostname();
        if(device[EVENT_LISTENER_ID] && this.listeners.has(device[EVENT_LISTENER_ID])) {
            return baseAddress + device[EVENT_LISTENER_ID];
        }
        const id = uuid();
        device[EVENT_LISTENER_ID] = id;
        this.listeners.set(id, device);
        return baseAddress + id;
    },
    removeDevice(device) {
        const id = device[EVENT_LISTENER_ID];
        this.listeners.delete(id);
        delete device[EVENT_LISTENER_ID];
    },
    startServer() {
        this.app = express();
        this.app.use(express.urlencoded({ extended: false }));
        this.app.post('/:device', (...args) => this.handleEvent(...args));
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(0, (error) => {
                if(error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            });
        });
    },
    getHostname() {
        const { port } = this.server.address();
        const interfaces = os.networkInterfaces();
        let address;
        Object.values(interfaces).some((iface) => {
            const interfaceDetail = iface.find((detail) => detail.family === 'IPv4' && !detail.internal);
            if(interfaceDetail) {
                address = interfaceDetail.address;
                return true;
            }
        });
        return `post://${address}:${port}/`;
    },
    handleEvent(request, response) {
        const { device: id } = request.params;
        // Make sure we know the device and that the request has all the context to identify the event
        if(this.listeners.has(id) && request.body.index) {
            const { index, action, mac } = request.body;
            const deviceName = `dingz-${mac.toLowerCase()}`;
            console.log(deviceName, index, action, id);
            const device = this.listeners.get(id);
            if(device.id !== deviceName) {
                console.warn('Impostor device:', deviceName, 'Expected device:', device.id);
                return;
            }
            device.updateFromDiscovery(request.ip);
            device.handleGenericEvent(index, action);
            response.sendStatus(204);
            return;
        }
        response.sendStatus(401);
    },
    destroy() {
        if(this.server) {
            this.server.close();
        }
        delete this.server;
        delete this.app;
        this.listeners.clear();
    }
};

module.exports = WebEventEndpoint;
