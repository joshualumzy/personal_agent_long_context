/**
 * Serializes asynchronous background tasks (such as memory updates) per employee
 * to prevent race conditions when multiple requests arrive in close succession.
 */
export class MemoryUpdateQueue {
  private queues = new Map<string, Promise<unknown>>();

  enqueue<T>(employeeId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(employeeId) ?? Promise.resolve();
    // Chain task so it runs after prev, even if prev rejected
    const next = prev.then(task, task);
    this.queues.set(employeeId, next);

    next.finally(() => {
      if (this.queues.get(employeeId) === next) {
        this.queues.delete(employeeId);
      }
    });

    return next as Promise<T>;
  }
}
