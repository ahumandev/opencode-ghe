# Purpose of Project

GHE provider tool-call protocol and stream bridge support.

Bridges provider serialization and SSE streams to AI SDK consumers.

## Provider Bridge Features

- **Chat serialization**: Serializes GHE provider requests for Chat.
- **Responses serialization**: Serializes GHE provider requests for Responses.
- **Tool-call protocol**: Handles GHE provider tool-call protocol.
- **SSE handling**: Processes provider server-sent event streams.
- **AI SDK stream bridge**: Bridges provider streams to AI SDK consumers.

## Core Flow

- Chat and Responses requests use provider serialization.
- Provider SSE streams pass through AI SDK stream bridge.
- Tool calls use GHE provider protocol.

## Architecture Map

- **Provider serialization**: Chat and Responses request handling.
- **SSE handling**: Provider stream event processing.
- **AI SDK bridge**: Provider stream adaptation for AI SDK consumers.
- **Protocol tests**: `tests/ghe-protocol.test.ts` covers GHE protocol.
- **Bridge tests**: `tests/ai-sdk-bridge.test.ts` covers AI SDK bridge.
