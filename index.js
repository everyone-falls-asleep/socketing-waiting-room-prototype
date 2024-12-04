import Fastify from "fastify";
import fastifyEnv from "@fastify/env";
import fastifyRedis from "@fastify/redis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

const schema = {
  type: "object",
  required: ["PORT", "CACHE_HOST", "CACHE_PORT"],
  properties: {
    PORT: {
      type: "integer",
    },
    CACHE_HOST: {
      type: "string",
    },
    CACHE_PORT: {
      type: "integer",
    },
  },
};

const fastify = Fastify({
  trustProxy: true,
  logger: true,
});

await fastify.register(fastifyEnv, {
  schema,
  dotenv: true,
});

await fastify.register(fastifyRedis, {
  host: fastify.config.CACHE_HOST,
  port: fastify.config.CACHE_PORT,
  family: 4,
});

fastify.get("/liveness", (request, reply) => {
  reply.send({ status: "ok", message: "The server is alive." });
});

const pubClient = fastify.redis.duplicate();
const subClient = fastify.redis.duplicate();

const io = new Server(fastify.server, {
  cors: {
    origin: "*",
    methods: "*",
    credentials: true,
  },
  transports: ["websocket"],
  adapter: createAdapter(pubClient, subClient),
});

io.on("connection", async (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Check if "mylist" exists
  const listExists = await fastify.redis.exists("mylist");

  // Add sample data only if "mylist" does not exist
  if (!listExists) {
    console.log('"mylist" does not exist. Adding sample data.');
    await fastify.redis.rpush("mylist", "A", "B", "C", "D");
  } else {
    console.log('"mylist" already exists. Skipping sample data addition.');
  }

  // Shuffle the list in place
  await shuffleListInPlace("mylist");

  // Retrieve and display the shuffled list
  const result = await fastify.redis.lrange("mylist", 0, -1);
  console.log("Shuffled list:", result);

  socket.on("disconnect", async () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

async function shuffleListInPlace(key) {
  const script = `
    local list = redis.call('LRANGE', KEYS[1], 0, -1)
    local n = #list
    for i = n, 2, -1 do
      local j = math.random(1, i)
      list[i], list[j] = list[j], list[i]
    end
    redis.call('DEL', KEYS[1])
    for i = 1, n do
      redis.call('RPUSH', KEYS[1], list[i])
    end
    return nil
  `;

  try {
    // Execute the Lua script with the given key
    await fastify.redis.eval(script, 1, key);
    console.log(`List ${key} shuffled in place.`);
  } catch (error) {
    console.error(`Error shuffling list ${key}:`, error);
  }
}

const startServer = async () => {
  try {
    const port = Number(fastify.config.PORT);
    const address = await fastify.listen({ port, host: "0.0.0.0" });

    fastify.log.info(`Server is now listening on ${address}`);

    if (process.send) {
      process.send("ready");
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

let shutdownInProgress = false; // 중복 호출 방지 플래그

async function gracefulShutdown(signal) {
  if (shutdownInProgress) {
    fastify.log.warn(
      `Shutdown already in progress. Ignoring signal: ${signal}`
    );
    return;
  }
  shutdownInProgress = true; // 중복 호출 방지

  fastify.log.info(`Received signal: ${signal}. Starting graceful shutdown...`);

  try {
    io.sockets.sockets.forEach((socket) => {
      socket.disconnect(true);
    });
    fastify.log.info("All Socket.IO connections have been closed.");

    await fastify.close();
    fastify.log.info("Fastify server has been closed.");

    await Promise.all([pubClient.quit(), subClient.quit()]);

    // 기타 필요한 종료 작업 (예: DB 연결 해제)
    // await database.disconnect();
    fastify.log.info("Additional cleanup tasks completed.");

    fastify.log.info("Graceful shutdown complete. Exiting process...");
    process.exit(0);
  } catch (error) {
    fastify.log.error("Error occurred during graceful shutdown:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
