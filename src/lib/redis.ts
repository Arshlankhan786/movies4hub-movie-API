import { RedisClient } from "bun";

const redisUrl = Bun.env.REDIS_URL;
const redis = new RedisClient(redisUrl, {
    autoReconnect: true,
    maxRetries: 3
});

export default redis;