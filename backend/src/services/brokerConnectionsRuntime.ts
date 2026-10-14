/**
 * The process-wide broker connection store and its sync to the broker
 * service (see brokerConnections.ts and brokerSync.ts).
 */
import { BrokerConnectionStore } from './brokerConnections.js';
import { BrokerSync } from './brokerSync.js';
import { dbService } from './database.js';

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

export const brokerConnectionStore = new BrokerConnectionStore(dbService);
export const brokerSync = new BrokerSync(brokerConnectionStore, BROKER_SERVICE_URL);
