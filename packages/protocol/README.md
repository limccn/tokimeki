# @limccn/tokimeki-protocol

[![npm](https://img.shields.io/npm/v/@limccn/tokimeki-protocol.svg)](https://www.npmjs.com/package/@limccn/tokimeki-protocol)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/limccn/tokimeki/blob/main/LICENSE)

Shared wire protocol for the tokimeki Cloudflare relay, CLI, and future
Go/Rust clients: binary frames, JSON control messages, error/close codes, and
golden fixtures.

```bash
npm install @limccn/tokimeki-protocol
```

```ts
import {
  decodeFrame,
  encodeControlMessage,
  parseControlMessage,
  PROTOCOL_VERSION,
} from "@limccn/tokimeki-protocol";
```

The normative protocol description is
[docs/protocol.md](https://github.com/limccn/tokimeki/blob/main/docs/protocol.md).

## License

Apache-2.0. See [LICENSE](https://github.com/limccn/tokimeki/blob/main/LICENSE).
