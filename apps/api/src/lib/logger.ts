import { pino } from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  name: "devlaunch-api",
  level: env.logLevel,
  redact: ["req.headers.authorization", "req.headers[\"x-dev-user-id\"]"],
});
