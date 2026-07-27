"use client";
import { useEffect, useState } from "react";

// ═══════════════════════════════════════════════════════════════
// HOW TO PLAY — Base Theme
// ═══════════════════════════════════════════════════════════════

const GRID_SIZE = 5;
const CELL_LABELS = [];
for (let r = 0; r < GRID_SIZE; r++)
  for (let c = 0; c < GRID_SIZE; c++)
    CELL_LABELS.push(`${String.fromCharCode(65 + r)}${c + 1}`);

// Base logo pattern
const DARK_CELLS = new Set([0,1,2,3,4, 5,9, 10,14, 15,19, 20,21,22,23,24]);
const OPENING_CELLS = new Set([11,12,13]);
const getCellZone = (idx) => {
  if (DARK_CELLS.has(idx)) return "dark";
  if (OPENING_CELLS.has(idx)) return "opening";
  return "light";
};

// Demo states for the example grid
const DEMO_CLAIMED = new Set([1, 8, 12]);
const DEMO_YOURS = 9; // B5
const DEMO_WINNER = 12; // C3

function HTPLogoIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}>
      <defs>
        <linearGradient id={`htplg${size}`} x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3B7BF6" />
          <stop offset="100%" stopColor="#1652F0" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="72" height="72" rx="16" fill={`url(#htplg${size})`} />
      <line x1="30" y1="4" x2="30" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="50" y1="4" x2="50" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="4" y1="30" x2="76" y2="30" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <line x1="4" y1="50" x2="76" y2="50" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
      <text x="40" y="56" textAnchor="middle" fontFamily="'Orbitron', sans-serif" fontWeight="900" fontSize="48" fill="white" letterSpacing="-2">G</text>
    </svg>
  );
}

export default function HowToPlay() {
  const [scanLine, setScanLine] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setScanLine(p => (p + 0.4) % 110), 40);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={S.root}>
      {/* Scan line */}
      <div style={{
        ...S.scanOverlay,
        background: `linear-gradient(180deg,
          transparent ${scanLine - 2}%,
          rgba(22,82,240,0.12) ${scanLine - 1}%,
          rgba(22,82,240,0.25) ${scanLine}%,
          rgba(22,82,240,0.12) ${scanLine + 1}%,
          transparent ${scanLine + 2}%)`,
      }} />
      <div style={S.crtLines} />

      {/* Header */}
      <header style={S.header}>
        <div style={S.hLeft}>
          <HTPLogoIcon size={28} />
          <span style={S.logo}>GR</span>
          <span style={S.logoSub}>OOD</span>
          <span style={S.badge}>HOW TO PLAY</span>
        </div>
        <div style={S.hRight}>
          <a href="/" style={S.backBtn}>← BACK TO GRID</a>
        </div>
      </header>

      {/* Content */}
      <div style={S.content}>
        {/* Hero */}
        <div style={S.hero}>
          <div style={S.heroTag}>PROTOCOL BRIEFING</div>
          <h1 style={S.heroTitle}>HOW TO PLAY</h1>
          <p style={S.heroDesc}>
            Pick a cell. Lock 1 USDG. A drand randomness beacon selects the winning cell.
            If it's yours, you take the pot. 30-second rounds, fully on-chain.
          </p>
        </div>

        {/* Steps */}
        <div style={S.steps}>
          <Step num="01" title="CONNECT & FUND">
            Sign in with your email, social account, or connect an existing wallet.
            You'll need <Hl>USDG on Robinhood Chain</Hl> to play. Each round costs <Hl>1 USDG</Hl> per cell pick.
          </Step>

          <Step num="02" title="PICK YOUR CELL">
            The grid is a <Hl>5×5 board with 25 cells</Hl>. Each round lasts <Hl>30 seconds</Hl>.
            Click any cell to select it, then confirm to lock your pick on-chain.
            Multiple players can pick the same cell.
          </Step>

          <Step num="03" title="ROUND RESOLVES">
            When the timer hits zero, the <Hl>drand beacon</Hl> pinned at round start is emitted
            by the League of Entropy network. Its BLS signature — which didn't exist while betting
            was open — is <Hl>verified by the contract itself</Hl> and picks the winning cell.
          </Step>

          <Step num="04" title="WINNERS GET PAID">
            If you picked the winning cell, you <span style={{ color: "#00CC88", fontWeight: 600 }}>split the pot</span> with
            anyone else who picked the same cell. Fewer players on your cell = bigger payout.
            All payouts are instant and on-chain. Winners also earn <Hl>$GROOD tokens</Hl>.
          </Step>

          <Step num="05" title="NEXT ROUND STARTS">
            A new round begins automatically. The grid resets, the timer restarts,
            and you can pick again. Every round is independent — fresh odds, fresh grid, fresh chance.
          </Step>
        </div>

        {/* Demo Grid */}
        <div style={S.demoSection}>
          <div style={S.demoLabel}>EXAMPLE ROUND</div>
          <div style={S.demoGridWrap}>
            <div style={S.cornerTL} /><div style={S.cornerTR} />
            <div style={S.cornerBL} /><div style={S.cornerBR} />
            <div style={S.demoGrid}>
              {CELL_LABELS.map((label, idx) => {
                const zone = getCellZone(idx);
                const isWinner = idx === DEMO_WINNER;
                const isYours = idx === DEMO_YOURS;
                const isClaimed = DEMO_CLAIMED.has(idx);

                let zoneStyle = zone === "dark" ? S.dcDark
                  : zone === "opening" ? S.dcOpening : S.dcLight;

                let stateStyle = {};
                if (isWinner) stateStyle = S.dcWinner;
                else if (isYours) stateStyle = S.dcYours;
                else if (isClaimed) stateStyle = S.dcPicked;

                return (
                  <div key={idx} style={{
                    ...S.demoCell, ...zoneStyle, ...stateStyle,
                    animationDelay: `${idx * 0.02}s`,
                  }}>
                    <span style={{ fontSize: 14 }}>
                      {isWinner ? "★" : isYours ? "◈" : isClaimed ? "◈" : "◇"}
                    </span>
                    <span style={{ fontSize: 8, letterSpacing: 1 }}>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div style={S.legend}>
            <LegendItem color="rgba(22,82,240,0.15)" border="rgba(22,82,240,0.2)" label="Empty" />
            <LegendItem color="rgba(22,82,240,0.35)" border="rgba(22,82,240,0.5)" label="Claimed" />
            <LegendItem color="rgba(22,82,240,0.5)" border="rgba(22,82,240,0.65)" label="Your Pick" glow />
            <LegendItem color="rgba(255,215,0,0.3)" border="rgba(255,215,0,0.5)" label="Winner" />
          </div>
        </div>

        {/* Info Cards */}
        <div style={S.infoGrid}>
          <InfoCard icon="⬡" title="PROVABLY FAIR">
            Every round uses a <Hl>drand beacon</Hl> verified <Hl>on-chain</Hl> by the game contract.
            The winning cell is determined by distributed randomness that nobody can predict or tamper with.
          </InfoCard>
          <InfoCard icon="◈" title="FULLY ON-CHAIN">
            All bets, payouts, and round results are recorded on <Hl>Robinhood Chain</Hl>.
            No custodial risk. Your funds are in the smart contract until you win.
            Verify everything on Blockscout.
          </InfoCard>
          <InfoCard icon="●" title="$GROOD REWARDS">
            Winners earn <Hl>$GROOD tokens</Hl> on top of the USDG pot.
            $GROOD is the native reward token — hold it, trade it, or accumulate for the Motherlode.
          </InfoCard>
          <InfoCard icon="↗" title="INSTANT PAYOUTS">
            Winners receive USDG directly to their wallet within seconds of each round resolving.
            No claiming, no delays — just on-chain settlement on Robinhood Chain.
          </InfoCard>
        </div>

        {/* Special Rounds */}
        <div style={S.specialsSection}>
          <div style={S.specialsTitle}>SPECIAL ROUNDS</div>
          <div style={S.specialCards}>
            <div style={S.specialMotherlode}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>★</div>
              <div style={{ ...S.specialName, color: "#FFD700" }}>MOTHERLODE</div>
              <div style={{ fontSize: 11, color: "rgba(255,215,0,0.6)", marginBottom: 10 }}>
                1 in 100 rounds (~every 50 minutes)
              </div>
              <div style={S.specialDesc}>
                Winners get 10× the normal USDG payout plus 10× the $GROOD emission.
                You won't know it's a Motherlode until the round resolves — every round could be the one.
              </div>
            </div>
            <div style={S.specialBonus}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>⚡</div>
              <div style={{ ...S.specialName, color: "#00CC88" }}>UNRIGGABLE TRIGGER</div>
              <div style={{ fontSize: 11, color: "rgba(0,204,136,0.6)", marginBottom: 10 }}>
                derived from the drand beacon
              </div>
              <div style={S.specialDesc}>
                Motherlodes are triggered by a second hash of the same drand beacon that picks the winner —
                visible to everyone, manipulable by no one.
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div style={S.ctaSection}>
          <a href="/" style={S.ctaBtn}>⬡ START PLAYING</a>
          <div style={S.ctaSub}>
            ON-CHAIN · ROBINHOOD · RANDOMNESS BY DRAND
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer style={S.footer}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <HTPLogoIcon size={16} />
          <span style={S.footerOnline}>GRID ONLINE</span>
        </span>
        <span style={{ fontSize: 11, color: "#4a5a6e", letterSpacing: 1 }}>ON-CHAIN · ROBINHOOD · RANDOMNESS BY DRAND</span>
      </footer>

      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { margin: 0; padding: 0; background: #060A14; overflow-x: hidden; }
        @keyframes cellAppear { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
        @keyframes glowBlue {
          0%, 100% { box-shadow: 0 0 8px rgba(22,82,240,0.25); }
          50% { box-shadow: 0 0 20px rgba(22,82,240,0.55); }
        }
        @keyframes winnerGlow {
          0%, 100% { box-shadow: 0 0 10px rgba(255,215,0,0.25); }
          50% { box-shadow: 0 0 25px rgba(255,215,0,0.55); }
        }
        @keyframes scanGlow {
          0% { text-shadow: 0 0 4px #3B7BF6; }
          50% { text-shadow: 0 0 12px #3B7BF6, 0 0 24px #3B7BF644; }
          100% { text-shadow: 0 0 4px #3B7BF6; }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @media (max-width: 640px) {
          .htp-info-grid { grid-template-columns: 1fr !important; }
          .htp-special-cards { flex-direction: column !important; }
          .htp-demo-grid { width: 260px !important; }
          .htp-hero-title { font-size: 24px !important; letter-spacing: 2px !important; }
        }
      `}</style>
    </div>
  );
}

// ── Sub-components ──
function Step({ num, title, children }) {
  return (
    <div style={S.step}>
      <div style={S.stepNum}>{num}</div>
      <div style={{ flex: 1 }}>
        <div style={S.stepTitle}>{title}</div>
        <div style={S.stepDesc}>{children}</div>
      </div>
    </div>
  );
}

function Hl({ children }) {
  return <span style={{ color: "#3B7BF6", fontWeight: 600 }}>{children}</span>;
}

function InfoCard({ icon, title, children }) {
  return (
    <div style={S.infoCard}>
      <div style={{ fontSize: 22, marginBottom: 10 }}>{icon}</div>
      <div style={S.infoCardTitle}>{title}</div>
      <div style={S.infoCardText}>{children}</div>
    </div>
  );
}

function LegendItem({ color, border, label, glow }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#4A5A72" }}>
      <div style={{
        width: 10, height: 10, borderRadius: 3,
        background: color, border: `1px solid ${border}`,
        ...(glow ? { boxShadow: "0 0 6px rgba(22,82,240,0.4)" } : {}),
      }} />
      {label}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════
const S = {
  root: {
    fontFamily: "'JetBrains Mono', monospace",
    background: "radial-gradient(ellipse at 30% 10%, #0D1A30 0%, #080E1C 40%, #060A14 100%)",
    color: "#E0E8F4", minHeight: "100vh",
    display: "flex", flexDirection: "column", position: "relative",
  },
  scanOverlay: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 2, transition: "background 0.04s linear",
  },
  crtLines: {
    position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: "none", zIndex: 1,
    background: "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(0,0,0,0.05) 2px, rgba(0,0,0,0.05) 4px)",
  },

  // Header
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "12px 20px", borderBottom: "1px solid rgba(22,82,240,0.12)",
    background: "rgba(8,12,22,0.95)", zIndex: 10, position: "relative",
  },
  hLeft: { display: "flex", alignItems: "center", gap: 10 },
  hRight: { display: "flex", alignItems: "center", gap: 16 },
  dot: { width: 10, height: 10, borderRadius: 3, background: "#1652F0", boxShadow: "0 0 12px rgba(22,82,240,0.6)" },
  logo: { fontFamily: "'Orbitron', sans-serif", fontWeight: 900, fontSize: 18, color: "#3B7BF6", letterSpacing: 3 },
  logoSub: { fontFamily: "'Orbitron', sans-serif", fontWeight: 500, fontSize: 18, color: "#E0E8F4", letterSpacing: 2 },
  badge: {
    fontSize: 9, padding: "3px 8px", borderRadius: 4,
    background: "rgba(22,82,240,0.12)", color: "#3B7BF6",
    letterSpacing: 1.5, fontWeight: 700, border: "1px solid rgba(22,82,240,0.2)",
  },
  backBtn: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 700,
    padding: "8px 18px", borderRadius: 8,
    border: "1px solid #1652F0",
    background: "linear-gradient(135deg, rgba(22,82,240,0.2), rgba(22,82,240,0.05))",
    color: "#3B7BF6", cursor: "pointer", letterSpacing: 1.5, textDecoration: "none",
  },

  // Content
  content: {
    flex: 1, maxWidth: 780, margin: "0 auto",
    padding: "40px 28px 60px", position: "relative", zIndex: 5,
  },

  // Hero
  hero: { textAlign: "center", marginBottom: 48 },
  heroTag: { fontSize: 10, letterSpacing: 3, color: "#3B7BF6", marginBottom: 14, fontWeight: 700 },
  heroTitle: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 36, fontWeight: 900,
    letterSpacing: 4, marginBottom: 16, color: "#E0E8F4",
  },
  heroDesc: {
    fontSize: 14, color: "#7A8DA6", lineHeight: 1.7,
    maxWidth: 560, margin: "0 auto",
  },

  // Steps
  steps: { display: "flex", flexDirection: "column", gap: 24 },
  step: {
    display: "flex", gap: 20, alignItems: "flex-start",
    padding: 22, border: "1px solid rgba(22,82,240,0.12)",
    borderRadius: 12, background: "rgba(22,82,240,0.02)",
  },
  stepNum: {
    flexShrink: 0, width: 44, height: 44,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'Orbitron', sans-serif", fontSize: 18, fontWeight: 900,
    color: "#3B7BF6", border: "2px solid rgba(22,82,240,0.3)",
    borderRadius: 10, background: "linear-gradient(145deg, rgba(22,82,240,0.12), rgba(22,82,240,0.04))",
  },
  stepTitle: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 14, fontWeight: 700,
    color: "#E0E8F4", letterSpacing: 1.5, marginBottom: 8,
  },
  stepDesc: { fontSize: 13, color: "#7A8DA6", lineHeight: 1.7 },

  // Demo Grid
  demoSection: { marginTop: 48, textAlign: "center" },
  demoLabel: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 12, fontWeight: 700,
    letterSpacing: 2, color: "#7A8DA6", marginBottom: 16,
  },
  demoGridWrap: { display: "inline-block", position: "relative", padding: 12 },
  demoGrid: { display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, width: 300 },
  demoCell: {
    aspectRatio: "1", borderRadius: 8,
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: 2, fontSize: 9, fontWeight: 600, animation: "cellAppear 0.4s ease both",
  },
  cornerTL: { position: "absolute", top: 0, left: 0, width: 18, height: 18, borderLeft: "2px solid rgba(22,82,240,0.4)", borderTop: "2px solid rgba(22,82,240,0.4)" },
  cornerTR: { position: "absolute", top: 0, right: 0, width: 18, height: 18, borderRight: "2px solid rgba(22,82,240,0.4)", borderTop: "2px solid rgba(22,82,240,0.4)" },
  cornerBL: { position: "absolute", bottom: 0, left: 0, width: 18, height: 18, borderLeft: "2px solid rgba(22,82,240,0.4)", borderBottom: "2px solid rgba(22,82,240,0.4)" },
  cornerBR: { position: "absolute", bottom: 0, right: 0, width: 18, height: 18, borderRight: "2px solid rgba(22,82,240,0.4)", borderBottom: "2px solid rgba(22,82,240,0.4)" },

  // Cell zones
  dcDark: {
    background: "linear-gradient(145deg, #0E2260, #081340)",
    border: "1px solid rgba(22,82,240,0.2)", color: "rgba(140,170,220,0.4)",
  },
  dcLight: {
    background: "linear-gradient(145deg, rgba(210,225,255,0.12), rgba(180,200,240,0.06))",
    border: "1px solid rgba(200,220,255,0.18)", color: "rgba(200,218,250,0.6)",
  },
  dcOpening: {
    background: "linear-gradient(145deg, rgba(230,240,255,0.16), rgba(200,218,250,0.08))",
    border: "1px solid rgba(220,235,255,0.22)", color: "rgba(215,232,255,0.65)",
  },
  dcPicked: { borderColor: "rgba(22,82,240,0.5)", color: "#3B7BF6" },
  dcYours: {
    borderColor: "rgba(22,82,240,0.6)", color: "#4D8EFF",
    animation: "glowBlue 2s ease-in-out infinite",
  },
  dcWinner: {
    background: "rgba(255,215,0,0.12)", borderColor: "rgba(255,215,0,0.5)",
    color: "#FFD700", animation: "winnerGlow 1.5s ease-in-out infinite",
  },

  legend: { display: "flex", justifyContent: "center", gap: 20, marginTop: 16, flexWrap: "wrap" },

  // Info Cards
  infoGrid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 48,
  },
  infoCard: {
    border: "1px solid rgba(22,82,240,0.12)", borderRadius: 10,
    background: "rgba(22,82,240,0.02)", padding: 20,
  },
  infoCardTitle: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 11, fontWeight: 700,
    letterSpacing: 1.5, color: "#E0E8F4", marginBottom: 8,
  },
  infoCardText: { fontSize: 12, color: "#7A8DA6", lineHeight: 1.6 },

  // Specials
  specialsSection: { marginTop: 48 },
  specialsTitle: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 14, fontWeight: 700,
    letterSpacing: 2, color: "#E0E8F4", marginBottom: 20, textAlign: "center",
  },
  specialCards: { display: "flex", gap: 16 },
  specialMotherlode: {
    flex: 1, borderRadius: 10, padding: 20, textAlign: "center",
    border: "1px solid rgba(255,215,0,0.2)",
    background: "linear-gradient(145deg, rgba(255,215,0,0.06), rgba(255,215,0,0.02))",
  },
  specialBonus: {
    flex: 1, borderRadius: 10, padding: 20, textAlign: "center",
    border: "1px solid rgba(0,204,136,0.2)",
    background: "linear-gradient(145deg, rgba(0,204,136,0.06), rgba(0,204,136,0.02))",
  },
  specialName: { fontFamily: "'Orbitron', sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.5, marginBottom: 6 },
  specialDesc: { fontSize: 12, color: "#7A8DA6", lineHeight: 1.6 },

  // CTA
  ctaSection: { marginTop: 56, textAlign: "center" },
  ctaBtn: {
    fontFamily: "'Orbitron', sans-serif", fontSize: 14, fontWeight: 700,
    padding: "18px 48px", borderRadius: 10, border: "none", cursor: "pointer",
    letterSpacing: 2, background: "linear-gradient(135deg, #1652F0, #3B7BF6)",
    color: "#fff", boxShadow: "0 4px 24px rgba(22,82,240,0.35)",
    textTransform: "uppercase", textDecoration: "none", display: "inline-block",
  },
  ctaSub: { fontSize: 11, color: "#4A5A72", marginTop: 12, letterSpacing: 1.5 },

  // Footer
  footer: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "10px 20px", borderTop: "1px solid rgba(22,82,240,0.12)",
    background: "rgba(8,12,22,0.95)", zIndex: 10, position: "relative",
  },
  footerDot: {
    display: "inline-block", width: 6, height: 6, borderRadius: "50%",
    background: "#1652F0", boxShadow: "0 0 8px rgba(22,82,240,0.6)",
  },
  footerOnline: {
    fontSize: 12, fontWeight: 700, color: "#3B7BF6", letterSpacing: 1.5,
    animation: "scanGlow 3s ease-in-out infinite",
  },
};
