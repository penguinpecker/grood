import Providers from "@/components/Providers";
import "./globals.css";

export const metadata = {
  title: "Grood — 5×5 On-Chain Game",
  description: "5×5 grid game on Robinhood Chain. Pick a cell, win USDG + GROOD tokens. Randomness by drand, verified on-chain.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Orbitron:wght@500;700;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body style={{ margin: 0, padding: 0, background: "#0a0f0c" }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
