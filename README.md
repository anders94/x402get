# x402get

A CLI tool for HTTP GET requests with automatic [x402](https://www.x402.org/) payment support. When a server responds with HTTP 402 Payment Required, x402get displays the price, checks your wallet balance, asks for confirmation, signs an EIP-3009 `TransferWithAuthorization`, and retries the request with payment.

## Installation

```bash
# Run directly with npx
npx x402get <url>

# Or install globally
npm install -g x402get
```

### Build from source

```bash
git clone https://github.com/anthropics/x402get.git
cd x402get
npm install
npm run build
node dist/cli.js <url>
```

Requires Node.js 20+ (for native `fetch`).

## Usage

```bash
x402get <url> [options]
```

### Options

| Option | Description |
|---|---|
| `-k, --private-key <key>` | Private key for signing payments |
| `-r, --rpc <url>` | RPC endpoint URL |
| `-o, --output <file>` | Save response body to a file |
| `-h, --help` | Show help |

### Environment variables

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Default private key (overridden by `--private-key`) |
| `RPC_ENDPOINT` | Default RPC URL (overridden by `--rpc`) |

## Examples

### Simple GET (no payment required)

```bash
x402get https://httpbin.org/get
```

### Fetch a paid resource

```bash
export PRIVATE_KEY=0xabc123...
x402get https://api.example.com/paid-endpoint
```

Output:

```
Fetching https://api.example.com/paid-endpoint...

=== x402 Payment Required ===
Resource:    https://api.example.com/paid-endpoint
Description: Premium API access
Price:       0.01 USDC
Network:     Base
Pay to:      0x1234...abcd
Wallet:      0xabcd...1234
Balance:     5.00 USDC

Proceed with payment? [y/N] y
Signing payment...
Retrying request with payment...
Payment tx: 0xdeadbeef...
{"data": "the paid content"}
Done.
```

### Pipe content to a file

All informational output goes to stderr, so stdout is clean for piping:

```bash
x402get https://api.example.com/paid-data > data.json
```

### Save binary content

```bash
x402get https://api.example.com/paid-image -o image.png
```

### Use a custom RPC

```bash
x402get https://api.example.com/resource --rpc https://my-rpc.example.com
```

## How it works

1. **GET request** — x402get fetches the URL normally.
2. **200 OK** — The response body is printed to stdout (text) or saved to a file (binary).
3. **402 Payment Required** — The server includes a base64-encoded `PAYMENT-REQUIRED` header describing accepted payment methods.
4. **Challenge parsing** — x402get decodes the challenge and selects a compatible `eip3009` (EIP-3009 `TransferWithAuthorization`) payment option.
5. **Balance check** — The tool queries the ERC-20 token contract for your wallet's balance.
6. **Confirmation** — A summary is displayed and you are prompted to approve or cancel.
7. **EIP-712 signing** — x402get signs a `TransferWithAuthorization` message using [EIP-712](https://eips.ethereum.org/EIPS/eip-712) typed data. No on-chain transaction is sent by the client — the server submits it.
8. **Retry** — The original request is retried with a `Payment-Signature` header containing the signed authorization.
9. **Response** — The paid content is returned. If the server includes a `PAYMENT-RESPONSE` header with a transaction hash, it is displayed on stderr.

## Supported chains

x402get includes built-in RPC endpoints and USDC token addresses for these networks:

| Chain | Chain ID | Default RPC |
|---|---|---|
| Ethereum | 1 | `https://eth.llamarpc.com` |
| Base | 8453 | `https://mainnet.base.org` |
| Base Sepolia | 84532 | `https://sepolia.base.org` |
| Radius | 723 | `https://rpc.radiustech.xyz` |
| Radius Testnet | 72344 | `https://rpc-testnet.radiustech.xyz` |
| Polygon | 137 | `https://polygon-rpc.com` |

Any EVM chain using the CAIP-2 `eip155:<chainId>` format is supported — provide the RPC endpoint via `--rpc` or `RPC_ENDPOINT` for chains not listed above.

## x402 protocol

The [x402 protocol](https://www.x402.org/) enables machine-to-machine payments over HTTP. It extends the HTTP 402 status code with a structured payment challenge/response flow:

- **Server** returns 402 with a `PAYMENT-REQUIRED` header (base64-encoded JSON) listing accepted payment schemes, token addresses, amounts, and chain identifiers.
- **Client** signs an off-chain authorization (EIP-3009 `TransferWithAuthorization`) and sends it back in a `PAYMENT-SIGNATURE` header.
- **Server** verifies the signature, submits the token transfer on-chain, and returns the requested resource along with a `PAYMENT-RESPONSE` header containing the transaction hash.

### Security considerations

- **Private keys** — Your private key never leaves your machine. It is used only to sign an EIP-712 typed data message. No raw transactions are broadcast by the client.
- **Confirmation** — Every payment requires explicit `y` confirmation before signing.
- **Amount visibility** — The exact token amount, recipient, network, and your balance are displayed before you confirm.
- **No blind signing** — The EIP-712 domain and message fields are fully specified by the server's challenge and can be inspected.

## License

MIT
