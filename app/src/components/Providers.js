"use client";
import { PrivyProvider } from "@privy-io/react-auth";
import { robinhood } from "@/lib/config";

export default function Providers({ children }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    return (
      <div style={{ color: "#FF5000", padding: 40, fontFamily: "monospace" }}>
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
          accentColor: "#00C805",
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
