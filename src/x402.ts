import { ethers } from "ethers";
import { ERC20_ABI, KNOWN_TOKENS } from "./constants";

export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  resource?: string | { url: string; description?: string };
  description?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface PaymentChallenge {
  accepts: PaymentRequirement[];
  error?: string;
  version?: string;
  x402Version?: number;
  resource?: { url?: string; description?: string } | string;
}

export interface TokenInfo {
  decimals: number;
  symbol: string;
  name: string;
}

export interface SignResult {
  signature: string;
  payload: Record<string, unknown>;
}

const SUPPORTED_SCHEMES = ["exact", "eip2612"];

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
  const options = challenge.accepts.filter((a) =>
    SUPPORTED_SCHEMES.includes(a.scheme)
  );
  if (options.length === 0) return null;
  // Prefer entries that already have extra.name (EIP-712 domain info provided)
  const withDomain = options.filter((a) => a.extra?.name);
  return withDomain.length > 0 ? withDomain[0] : options[0];
}

export function parseChainId(network: string): number {
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

export function getPaymentAmount(requirement: PaymentRequirement): string {
  return requirement.maxAmountRequired || requirement.amount || "0";
}

async function signEIP3009(
  wallet: ethers.Wallet,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  const extra = requirement.extra || {};
  const from = wallet.address;
  const to = requirement.payTo;
  const value = getPaymentAmount(requirement);
  const validAfter = (extra.validAfter as string) || "0";
  const validBefore =
    (extra.validBefore as string) ||
    "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const domain = {
    name: (extra.name as string) || tokenInfo.name,
    version: (extra.version as string) || "2",
    chainId,
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

  const message = { from, to, value, validAfter, validBefore, nonce };
  const signature = await wallet.signTypedData(domain, types, message);

  return {
    signature,
    payload: {
      signature,
      authorization: { from, to, value, validAfter, validBefore, nonce },
    },
  };
}

async function signEIP2612(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  const extra = requirement.extra || {};
  const owner = wallet.address;
  const spender = requirement.payTo;
  const value = getPaymentAmount(requirement);

  // Fetch the sequential nonce from the token contract
  const contract = new ethers.Contract(requirement.asset, ERC20_ABI, provider);
  const nonce: bigint = await contract.nonces(owner);

  // Deadline: now + maxTimeoutSeconds (or 60s default)
  const timeout = requirement.maxTimeoutSeconds || 60;
  const deadline = Math.floor(Date.now() / 1000) + timeout;

  const domain = {
    name: (extra.name as string) || tokenInfo.name,
    version: (extra.version as string) || "1",
    chainId,
    verifyingContract: ethers.getAddress(requirement.asset),
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner,
    spender,
    value,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    signature,
    payload: {
      signature,
      permit: { owner, spender, value, nonce: nonce.toString(), deadline: deadline.toString() },
    },
  };
}

export async function signPayment(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  if (requirement.scheme === "eip2612") {
    return signEIP2612(wallet, provider, requirement, chainId, tokenInfo);
  }
  return signEIP3009(wallet, requirement, chainId, tokenInfo);
}

export function buildPaymentHeader(
  requirement: PaymentRequirement,
  signResult: SignResult
): string {
  const header = {
    x402Version: 2,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: signResult.payload,
  };
  return Buffer.from(JSON.stringify(header)).toString("base64");
}
