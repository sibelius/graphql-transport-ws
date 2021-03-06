import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  execute,
  subscribe,
  GraphQLNonNull,
} from 'graphql';
import net from 'net';
import http from 'http';
import { PubSub } from 'graphql-subscriptions';
import { createServer, ServerOptions, Server } from '../../server';

export const pubsub = new PubSub();

// use for dispatching a `pong` to the `ping` subscription
let pendingPongs = 0;
let nextPong: ((done: boolean) => void) | undefined;
export function pong(): void {
  if (nextPong) {
    nextPong(false);
  } else {
    pendingPongs++;
  }
}

const personType = new GraphQLObjectType({
  name: 'Person',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

export const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      getValue: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: () => 'value',
      },
    },
  }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      greetings: {
        type: new GraphQLNonNull(GraphQLString),
        subscribe: async function* () {
          for (const hi of ['Hi', 'Bonjour', 'Hola', 'Ciao', 'Zdravo']) {
            yield { greetings: hi };
          }
        },
      },
      ping: {
        type: new GraphQLNonNull(GraphQLString),
        subscribe: function () {
          return {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              if (pendingPongs > 0) {
                pendingPongs--;
                return { value: { ping: 'pong' } };
              }
              const done = await new Promise((resolve) => (nextPong = resolve));
              if (done) {
                return { done: true };
              }
              return { value: { ping: 'pong' } };
            },
            async return() {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              nextPong!(true);
              nextPong = undefined;
              return { done: true };
            },
            async throw() {
              throw new Error('Ping no gusta');
            },
          };
        },
      },
      // TODO-db-201022 testing `graphql-subscriptions` is not necessary. refactor the client and rely on the ping/pong above
      becameHappy: {
        type: personType,
        args: {
          secret: {
            type: new GraphQLNonNull(GraphQLString),
          },
        },
        resolve: (source) => {
          if (source instanceof Error) {
            throw source;
          }
          return source.becameHappy;
        },
        subscribe: () => {
          return pubsub.asyncIterator('becameHappy');
        },
      },
      boughtBananas: {
        type: personType,
        resolve: (source) => {
          if (source instanceof Error) {
            throw source;
          }
          return source.boughtBananas;
        },
        subscribe: () => {
          return pubsub.asyncIterator('boughtBananas');
        },
      },
    },
  }),
});

export const port = 8273,
  path = '/graphql-simple',
  url = `ws://localhost:${port}${path}`;

export async function startServer(
  options: Partial<ServerOptions> = {},
): Promise<[Server, (beNice?: boolean) => Promise<void>]> {
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  // sockets to kick off on teardown
  const sockets = new Set<net.Socket>();
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    httpServer.once('close', () => sockets.delete(socket));
  });

  const server = await createServer(
    {
      schema,
      execute,
      subscribe,
      ...options,
    },
    {
      server: httpServer,
      path,
    },
  );

  await new Promise((resolve) => httpServer.listen(port, resolve));

  return [
    server,
    (beNice) =>
      new Promise((resolve, reject) => {
        if (!beNice) {
          for (const socket of sockets) {
            socket.destroy();
            sockets.delete(socket);
          }
        }

        const disposing = server.dispose() as Promise<void>;
        disposing.catch(reject).then(() => {
          httpServer.close(() => resolve());
        });
      }),
  ];
}
