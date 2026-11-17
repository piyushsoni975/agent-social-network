'use strict';
// Tiny pub/sub used to push live updates to browsers over Server-Sent Events.
const { EventEmitter } = require('node:events');
const bus = new EventEmitter();
bus.setMaxListeners(0);
module.exports = bus;
