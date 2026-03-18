export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  84532: "Base Sepolia",
  723: "Radius",
  72344: "Radius Testnet",
  137: "Polygon",
};

export const DEFAULT_RPCS: Record<number, string> = {
  1: "https://eth.llamarpc.com",
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org",
  723: "https://rpc.radiustech.xyz",
  72344: "https://rpc-testnet.radiustech.xyz",
  137: "https://polygon-rpc.com",
};

export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

export const KNOWN_TOKENS: Record<
  number,
  Record<string, { decimals: number; symbol: string; name: string }>
> = {
  8453: {
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    },
  },
  84532: {
    "0x036CbD53842c5426634e7929541eC2318f3dCF7e": {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    },
  },
  1: {
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    },
  },
  137: {
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359": {
      decimals: 6,
      symbol: "USDC",
      name: "USD Coin",
    },
  },
};
