import { MemoryService } from './memory-service';

export * from './types';
export * from './memory-service';
export * from './memory-repository';
export * from './memory-security';
export { createMemoryTools } from './tools/memory-tools';

let memoryServiceInstance: MemoryService | null = null;

export function getMemoryService(): MemoryService {
  if (!memoryServiceInstance) {
    memoryServiceInstance = new MemoryService();
  }
  return memoryServiceInstance;
}

export function setMemoryServiceForTesting(service: MemoryService | null): void {
  memoryServiceInstance = service;
}
