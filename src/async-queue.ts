/**
 * FIFO queue where `pop` awaits until an item is available.
 *
 * Single-consumer: at most one `pop` may be pending at a time. Calling
 * `pop` while another `pop` is already awaiting throws.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private waiter: ((item: T) => void) | undefined;

  push(item: T): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(item);
    } else {
      this.items.push(item);
    }
  }

  async pop(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    if (this.waiter) {
      throw new Error(
        "AsyncQueue is single-consumer; concurrent pop() is not allowed.",
      );
    }
    return new Promise<T>((resolve) => {
      this.waiter = resolve;
    });
  }
}
