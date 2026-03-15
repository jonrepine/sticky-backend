const express = require('express');
const cors = require('cors');
const { json } = require('express');
const { expressMiddleware } = require('@apollo/server/express4');
const config = require('./config');
const { initApp } = require('./createServer');

async function bootstrap() {
  const { server, contextFactory } = await initApp();
  await server.start();

  const app = express();

  app.use(
    '/',
    cors({ origin: true }),
    json(),
    expressMiddleware(server, { context: contextFactory })
  );

  app.listen(config.port, () => {
    console.log(`GraphQL server ready at http://localhost:${config.port}/`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
