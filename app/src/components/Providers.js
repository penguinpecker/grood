"use client";
import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export default function Providers({ children }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return (
      <div style={{ color: "#ff3355", padding: 40, fontFamily: "monospace" }}>
        ERROR: NEXT_PUBLIC_PRIVY_APP_ID not set
      </div>
    );
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#ff8800",
        },
        embeddedWallets: {
          createOnLogin: "all-users",
          showWalletUIs: false,
        },
        defaultChain: robinhood,
        supportedChains: [robinhood],
        loginMethods: ["twitter", "google", "wallet"],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
