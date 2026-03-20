import { ethers } from "ethers";
import { ERC20_ABI, KNOWN_TOKENS } from "./constants";

// Canonical Permit2 address (same on all EVM chains via CREATE2)
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// x402 Exact Permit2 Proxy
const X402_EXACT_PERMIT2_PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  resource?: string | { url: string; description?: string };
  description?: string;
  extra?: Record<string, unknown>;
}

export interface PaymentChallenge {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
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
  extensions?: Record<string, unknown>;
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
  // Only support the "exact" scheme per the x402 v2 spec
  const options = challenge.accepts.filter((a) => a.scheme === "exact");
  if (options.length === 0) return null;
  // Prefer entries that already have extra.name (EIP-712 domain info provided)
  const withDomain = options.filter((a) => a.extra?.name);
  return withDomain.length > 0 ? withDomain[0] : options[0];
}

export function getTransferMethod(requirement: PaymentRequirement): string {
  return (requirement.extra?.assetTransferMethod as string) || "eip3009";
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

// EIP-3009 TransferWithAuthorization signing
async function signEIP3009(
  wallet: ethers.Wallet,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  const extra = requirement.extra || {};
  const from = wallet.address;
  const to = requirement.payTo;
  const value = requirement.amount;
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

// Sign an EIP-2612 permit to approve Permit2 to spend the token
async function signEIP2612Permit(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo,
  deadline: string
): Promise<Record<string, unknown>> {
  const extra = requirement.extra || {};
  const tokenAddress = ethers.getAddress(requirement.asset);
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

  const nonce: bigint = await contract.nonces(wallet.address);

  const domain = {
    name: (extra.name as string) || tokenInfo.name,
    version: (extra.version as string) || "1",
    chainId,
    verifyingContract: tokenAddress,
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

  // Approve max uint256 to Permit2
  const approvalAmount = ethers.MaxUint256.toString();

  const message = {
    owner: wallet.address,
    spender: ethers.getAddress(PERMIT2_ADDRESS),
    value: BigInt(approvalAmount),
    nonce,
    deadline: BigInt(deadline),
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return {
    from: wallet.address,
    asset: tokenAddress,
    spender: ethers.getAddress(PERMIT2_ADDRESS),
    amount: approvalAmount,
    nonce: nonce.toString(),
    deadline,
    signature,
    version: (extra.version as string) || "1",
  };
}

// Permit2 PermitWitnessTransferFrom signing
async function signPermit2(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = (now - 600).toString(); // 10 min clock skew tolerance
  const deadline = (now + (requirement.maxTimeoutSeconds || 60)).toString();

  // Random 256-bit nonce as decimal string
  const nonceBytes = ethers.randomBytes(32);
  const nonce = BigInt(ethers.hexlify(nonceBytes)).toString();

  const permit2Authorization = {
    from: wallet.address,
    permitted: {
      token: ethers.getAddress(requirement.asset),
      amount: requirement.amount,
    },
    spender: ethers.getAddress(X402_EXACT_PERMIT2_PROXY),
    nonce,
    deadline,
    witness: {
      to: ethers.getAddress(requirement.payTo),
      validAfter,
    },
  };

  const domain = {
    name: "Permit2",
    chainId,
    verifyingContract: ethers.getAddress(PERMIT2_ADDRESS),
  };

  // Types must be in alphabetical order after the primary type
  const types = {
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Witness" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    Witness: [
      { name: "to", type: "address" },
      { name: "validAfter", type: "uint256" },
    ],
  };

  // Convert to BigInt for signing as the spec requires uint256
  const message = {
    permitted: {
      token: permit2Authorization.permitted.token,
      amount: BigInt(permit2Authorization.permitted.amount),
    },
    spender: permit2Authorization.spender,
    nonce: BigInt(permit2Authorization.nonce),
    deadline: BigInt(permit2Authorization.deadline),
    witness: {
      to: permit2Authorization.witness.to,
      validAfter: BigInt(permit2Authorization.witness.validAfter),
    },
  };

  const permit2Signature = await wallet.signTypedData(domain, types, message);

  // Check if Permit2 already has sufficient allowance on the token
  const tokenContract = new ethers.Contract(requirement.asset, ERC20_ABI, provider);
  const currentAllowance: bigint = await tokenContract.allowance(
    wallet.address,
    PERMIT2_ADDRESS
  );

  let extensions: Record<string, unknown> | undefined;
  if (currentAllowance < BigInt(requirement.amount)) {
    // Need EIP-2612 gas sponsoring to approve Permit2
    const eip2612Info = await signEIP2612Permit(
      wallet, provider, requirement, chainId, tokenInfo, deadline
    );
    extensions = {
      eip2612GasSponsoring: { info: eip2612Info },
    };
  }

  return {
    signature: permit2Signature,
    payload: {
      signature: permit2Signature,
      permit2Authorization,
    },
    ...(extensions ? { extensions } : {}),
  };
}

export async function signPayment(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  requirement: PaymentRequirement,
  chainId: number,
  tokenInfo: TokenInfo
): Promise<SignResult> {
  const method = getTransferMethod(requirement);
  if (method === "permit2") {
    return signPermit2(wallet, provider, requirement, chainId, tokenInfo);
  }
  return signEIP3009(wallet, requirement, chainId, tokenInfo);
}

// Build the PAYMENT-SIGNATURE header per x402 v2 spec
export function buildPaymentHeader(
  requirement: PaymentRequirement,
  signResult: SignResult
): string {
  const header: Record<string, unknown> = {
    x402Version: 2,
    accepted: requirement,
    payload: signResult.payload,
  };
  if (signResult.extensions) {
    header.extensions = signResult.extensions;
  }
  return Buffer.from(JSON.stringify(header)).toString("base64");
}
