// Framework-independent foundation types. Business capabilities are not implemented yet.
export const SERVICE_NODE_VERSION = '24.19.0';
export const SERVICE_PROTOCOL_VERSION = 1;
export type ServicePhase = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
