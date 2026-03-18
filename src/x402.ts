import { ethers } from "ethers";
import { ERC20_ABI, KNOWN_TOKENS } from "./constants";

export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  asset: string;
  payTo: string;
  extra?: {
    name?: string;
    version?: string;
    validAfter?: string;
    validBefore?: string;
  };
}

export interface PaymentChallenge {
  accepts: PaymentRequirement[];
  error?: string;
  version?: string;
}

export interface TokenInfo {
  decimals: number;
  symbol: string;
  name: string;
}

export function parsePaymentChallenge(response: Response): PaymentChallenge {
  const header = response.headers.get("payment-required");
  if (!header) {
    throw new Error("Missing PAYMENT-REQUIRED header in 402 response");
  }
  const decoded = Buffer.from(header, "base64").toString("utf-8");
  return JSON.parse(decoded);
}

export function selectPaymentOption(
  challenge: PaymentChallenge
): PaymentRequirement | null {
  const eip3009Options = challenge.accepts.filter(
    (a) => a.scheme === "exact" && a.extra?.name
  );
  if (eip3009Options.length === 0) return null;
  return eip3009Options[0];
}

export function parseChainId(network: string): number {
  // CAIP-2 format: eip155:<chainId>
  const match = network.match(/^eip155:(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported network format: ${network}`);
  }
  return parseInt(match[1], 10);
}

export async function getTokenInfo(
  provider: ethers.JsonRpcProvider,
  asset: string,
  chainId: number
): Promise<TokenInfo> {
  const checksummed = ethers.getAddress(asset);
  const cached = KNOWN_TOKENS[chainId]?.[checksummed];
  if (cached) return cached;

  const contract = new ethers.Contract(checksummed, ERC20_ABI, provider);
  const [decimals, symbol, name] = await Promise.all([
    contract.decimals(),
    contract.symbol(),
    contract.name(),
  ]);
  return { decimals: Number(decimals), symbol, name };
}

export async function getBalance(
  provider: ethers.JsonRpcProvider,
  asset: string,
  address: string
): Promise<bigint> {
  const contract = new ethers.Contract(asset, ERC20_ABI, provider);
  return contract.balanceOf(address);
}

export function formatAmount(amount: string | bigint, decimals: number): string {
  return ethers.formatUnits(amount, decimals);
}

export async function signPayment(
  wallet: ethers.Wallet,
  requirement: PaymentRequirement,
  chainId: number
): Promise<{ signature: string; authorization: Record<string, unknown> }> {
  const extra = requirement.extra!;
  const from = wallet.address;
  const to = requirement.payTo;
  const value = requirement.maxAmountRequired;
  const validAfter = extra.validAfter || "0";
  const validBefore =
    extra.validBefore || "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

  // Generate a random nonce (32 bytes)
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const domain = {
    name: extra.name!,
    version: extra.version || "2",
    chainId: chainId,
    verifyingContract: ethers.getAddress(requirement.asset),
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    signature,
    authorization: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  };
}

export function buildPaymentHeader(
  requirement: PaymentRequirement,
  signature: string,
  authorization: Record<string, unknown>
): string {
  const payload = {
    x402Version: 2,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
