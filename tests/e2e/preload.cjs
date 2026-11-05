// Reroute LINE and Google API calls to the local mock server.
const realFetch = globalThis.fetch;
const HOSTS = ["https://api.line.me", "https://www.googleapis.com", "https://oauth2.googleapis.com", "https://generativelanguage.googleapis.com", "https://aiplatform.googleapis.com", "https://api.telegram.org", "https://sheets.googleapis.com"];
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  const host = HOSTS.find((h) => url.startsWith(h));
  if (!host) return realFetch(input, init);
  const rewritten = "http://127.0.0.1:3457" + url.slice(host.length);
  if (typeof input === "object" && input.url) return realFetch(new Request(rewritten, input), init);
  return realFetch(rewritten, init);
};

// google-auth-library sends through node-fetch, which uses the https module directly.
const http = require("node:http");
const https = require("node:https");
const realRequest = https.request;
const HOSTNAMES = new Set(HOSTS.map((h) => new URL(h).hostname));
https.request = (...args) => {
  const url = args[0] instanceof URL || typeof args[0] === "string" ? new URL(args[0]) : null;
  const options = url ? (typeof args[1] === "object" ? args[1] : {}) : args[0];
  const cb = args.find((a) => typeof a === "function");
  const hostname = url?.hostname ?? options.hostname ?? options.host;
  if (!HOSTNAMES.has(hostname)) return realRequest(...args);
  const path = url ? url.pathname + url.search : options.path;
  const { agent, ...rest } = options;
  return http.request({ ...rest, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port: 3457, path }, cb);
};
