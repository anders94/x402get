#!/usr/bin/env node

import { program } from "commander";
import { ethers } from "ethers";
import * as fs from "fs";
import * as readline from "readline";
import { CHAIN_NAMES, DEFAULT_RPCS } from "./constants";
import {
  parsePaymentChallenge,
  selectPaymentOption,
  parseChainId,
  getTokenInfo,
  getBalance,
  formatAmount,
  signPayment,
  buildPaymentHeader,
} from "./x402";

function log(msg: string) {
  process.stderr.write(msg + "\n");
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  return /^(text\/|application\/json|application\/xml|application\/javascript)/.test(
    contentType
  );
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

async function handleResponse(
  response: Response,
  outputFile: string | undefined
) {
  const contentType = response.headers.get("content-type");

  if (outputFile) {
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);
    log(`Saved to ${outputFile} (${buffer.length} bytes)`);
    return;
  }

  if (isTextContentType(contentType)) {
    const text = await response.text();
    process.stdout.write(text);
    if (text.length > 0 && !text.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = contentType?.split("/")[1]?.split(";")[0] || "bin";
    const filename = `response.${ext}`;
    fs.writeFileSync(filename, buffer);
    log(`Binary response saved to ${filename} (${buffer.length} bytes)`);
  }
}

async function main() {
  program
    .name("x402get")
    .description("HTTP GET with x402 payment support")
    .argument("<url>", "URL to fetch")
    .option("-k, --private-key <key>", "private key for signing payments")
    .option("-r, --rpc <url>", "RPC endpoint URL")
    .option("-o, --output <file>", "save response to file")
    .parse();

  const url = program.args[0];
  const opts = program.opts();

  log(`Fetching ${url}...`);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error: ${msg}`);
    process.exit(1);
  }

  if (response.ok) {
    await handleResponse(response, opts.output);
    return;
  }

  if (response.status !== 402) {
    log(`Error: HTTP ${response.status} ${response.statusText}`);
    const body = await response.text().catch(() => "");
    if (body) log(body);
    process.exit(1);
  }

  // --- 402 Payment Required ---

  // Dump raw headers for debugging
  const rawHeader = response.headers.get("payment-required");
  let challenge;
  try {
    challenge = parsePaymentChallenge(response);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error parsing payment challenge: ${msg}`);
    if (rawHeader) {
      log(`\nRaw PAYMENT-REQUIRED header:\n${rawHeader}`);
      try {
        const decoded = Buffer.from(rawHeader, "base64").toString("utf-8");
        log(`\nDecoded:\n${decoded}`);
      } catch {
        // not base64
      }
    }
    // Show all response headers
    log("\nResponse headers:");
    response.headers.forEach((value, key) => {
      log(`  ${key}: ${value}`);
    });
    process.exit(1);
  }

  const requirement = selectPaymentOption(challenge);
  if (!requirement) {
    log("Error: No supported payment scheme found in 402 challenge");
    log(
      `Available schemes: ${challenge.accepts.map((a) => a.scheme).join(", ")}`
    );
    log(`\nFull challenge:\n${JSON.stringify(challenge, null, 2)}`);
    process.exit(1);
  }

  const chainId = parseChainId(requirement.network);
  const chainName = CHAIN_NAMES[chainId] || `Chain ${chainId}`;

  // Resolve RPC
  const rpcUrl =
    opts.rpc || process.env.RPC_ENDPOINT || DEFAULT_RPCS[chainId];
  if (!rpcUrl) {
    log(`Error: No RPC endpoint available for ${chainName} (chain ${chainId})`);
    log("Provide one with --rpc or RPC_ENDPOINT env var");
    process.exit(1);
  }

  // Resolve private key
  const privateKey = opts.privateKey || process.env.PRIVATE_KEY;
  if (!privateKey) {
    log("Error: Private key required for payment");
    log("Provide with --private-key or PRIVATE_KEY env var");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  // Query token info and balance in parallel
  const [tokenInfo, balance] = await Promise.all([
    getTokenInfo(provider, requirement.asset, chainId),
    getBalance(provider, requirement.asset, wallet.address),
  ]);

  const price = formatAmount(requirement.amount, tokenInfo.decimals);
  const balanceFormatted = formatAmount(balance, tokenInfo.decimals);

  // Resolve resource URL and description from challenge or requirement
  const chalResource = challenge.resource;
  const reqResource = requirement.resource;
  const resourceUrl =
    (typeof chalResource === "object" ? chalResource.url : chalResource) ||
    (typeof reqResource === "object" ? reqResource.url : reqResource) ||
    url;
  const description =
    (typeof chalResource === "object" ? chalResource.description : undefined) ||
    (typeof reqResource === "object" ? reqResource.description : undefined) ||
    requirement.description;

  log("");
  log("=== x402 Payment Required ===");
  log(`Resource:    ${resourceUrl}`);
  if (description) {
    log(`Description: ${description}`);
  }
  log(`Price:       ${price} ${tokenInfo.symbol}`);
  log(`Network:     ${chainName}`);
  log(`Pay to:      ${requirement.payTo}`);
  log(`Wallet:      ${wallet.address}`);
  log(`Balance:     ${balanceFormatted} ${tokenInfo.symbol}`);
  log("");

  if (balance < BigInt(requirement.amount)) {
    log(
      `Error: Insufficient balance. Need ${price} ${tokenInfo.symbol}, have ${balanceFormatted} ${tokenInfo.symbol}`
    );
    process.exit(1);
  }

  const proceed = await confirm("Proceed with payment? [y/N] ");
  if (!proceed) {
    log("Payment cancelled.");
    process.exit(0);
  }

  log("Signing payment...");
  const signResult = await signPayment(wallet, requirement, chainId, tokenInfo);
  const paymentHeader = buildPaymentHeader(requirement, signResult);

  log("Retrying request with payment...");
  let paidResponse: Response;
  try {
    paidResponse = await fetch(url, {
      headers: {
        "Payment-Signature": paymentHeader,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error on paid request: ${msg}`);
    process.exit(1);
  }

  if (!paidResponse.ok) {
    log(`Error: Payment request returned HTTP ${paidResponse.status}`);
    const body = await paidResponse.text().catch(() => "");
    if (body) log(body);
    // Show payment-related response headers
    const paidPaymentHeader = paidResponse.headers.get("payment-required");
    if (paidPaymentHeader) {
      try {
        const decoded = JSON.parse(
          Buffer.from(paidPaymentHeader, "base64").toString("utf-8")
        );
        log(`\nServer payment response:\n${JSON.stringify(decoded, null, 2)}`);
      } catch {
        log(`\nRaw PAYMENT-REQUIRED header:\n${paidPaymentHeader}`);
      }
    }
    process.exit(1);
  }

  // Check for payment response header
  const paymentResponse = paidResponse.headers.get("payment-response");
  if (paymentResponse) {
    try {
      const decoded = JSON.parse(
        Buffer.from(paymentResponse, "base64").toString("utf-8")
      );
      if (decoded.txHash) {
        log(`Payment tx: ${decoded.txHash}`);
      }
    } catch {
      // ignore parse errors on response header
    }
  }

  await handleResponse(paidResponse, opts.output);
  log("Done.");
}

main().catch((err) => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
