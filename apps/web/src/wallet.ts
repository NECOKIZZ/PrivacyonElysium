import { createPublicClient, createWalletClient, custom, http, type PublicClient, type WalletClient } from "viem";
import { elysium } from "@cloakely/sdk";

export const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://rpc.elysium.kinetiq.xyz";
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? "https://keeper.oncloak.xyz";
export const CHAIN = { ...elysium, rpcUrls: { default: { http: [RPC_URL] } } };

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL), pollingInterval: 500 }) as PublicClient;

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
const injected = () => (globalThis as unknown as { ethereum?: Eip1193 }).ethereum;

export async function connectWallet(): Promise<WalletClient> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Open this page in a wallet's browser, or install one.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as `0x${string}`[];
  const hex = `0x${CHAIN.id.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: "Elysium", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: ["https://elysium.kinetiq.xyz/explorer"] }],
    });
  }
  return createWalletClient({ account: address, chain: CHAIN, transport: custom(eth) });
}
