

export class RouteHandler {
  inputSchema: unknown; // TODO: JsonSchema from ./schema.js
  outputSchema: unknown; // TODO: JsonSchema from ./schema.js
  handlerFunc: (message: string) => Promise<string>;

  constructor(
    inputSchema: unknown,
    outputSchema: unknown,
    handlerFunc: (message: string) => Promise<string>,
  ) {
    this.inputSchema = inputSchema;
    this.outputSchema = outputSchema;
    this.handlerFunc = handlerFunc;
  }

  // TODO - add a static generic func for making these easily from
  // an arbitrary input and output type (provided they have are convertable / have schemas)
  static fromFunction<TInput, TOutput>(
    func: (input: TInput) => Promise<TOutput>,
    inputSchema: unknown,
    outputSchema: unknown,
  ): RouteHandler {
    return new RouteHandler(inputSchema, outputSchema, async (message) => {
      // TODO - validate and convert message to TInput using inputSchema
      const input = JSON.parse(message) as TInput;
      const output = await func(input);
      // TODO - validate and convert output to string using outputSchema
      return JSON.stringify(output);
    });
  }
}

/**
 * Router is reasonable for routing an Actor's messages to registered handlers.
 */
export class Router {
  private handlers: Record<string, RouteHandler> = {};

  constructor() {
  }

  registerRoute(route: string, handler: RouteHandler) {
    if (this.handlers[route]) {
      throw new Error(`Route "${route}" is already registered.`);
    }
    this.handlers[route] = handler;
  }

  unregisterRoute(route: string) {
    delete this.handlers[route];
  }

  async handleMessage(route: string, message: string): Promise<string> {
    const handler = this.handlers[route];
    if (!handler) {
      throw new Error(`No handler registered for route "${route}".`);
    }
    try {
      // TODO - convert to and from the schemas defined on the handler
      return await handler.handle(message);
    } catch (err) {
      console.error(`Error handling message on route "${route}":`, err);
      throw err;
    }
  }

  getHandlers(): Record<string, RouteHandler> {
    return this.handlers;
  }
}