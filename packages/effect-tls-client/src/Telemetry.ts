import { Metric } from "effect";

export const bytesRead = Metric.counter("tls_client.bytes.read", {
  incremental: true,
});

export const bytesWritten = Metric.counter("tls_client.bytes.written", {
  incremental: true,
});

export const requests = Metric.counter("tls_client.requests", {
  incremental: true,
});

export const sessionsActive = Metric.gauge("tls_client.sessions.active");

export const webSocketConnectionsActive = Metric.gauge(
  "tls_client.ws.connections.active",
);
