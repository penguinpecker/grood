"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const DARK = new Set([0,1,2,3,4,5,9,10,14,15,19,20,21,22,23,24]);
const OPEN = new Set([11,12,13]);
const LBL = [];
for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) LBL.push(String.fromCharCode(65+r)+(c+1));
const CLAIMED = [7,9,12,13];

function LogoIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" style={{display:"inline-block",verticalAlign:"middle",flexShrink:0}}>
      <defs><linearGradient id={`lg${size}`} x1="0" y1="0" x2="80" y2="80" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#00C805"/><stop offset="100%" stopColor="#009B04"/>
      </linearGradient></defs>
      <rect x="4" y="4" width="72" height="72" rx="16" fill={`url(#lg${size})`}/>
      <line x1="30" y1="4" x2="30" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5"/>
      <line x1="50" y1="4" x2="50" y2="76" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5"/>
      <line x1="4" y1="30" x2="76" y2="30" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5"/>
      <line x1="4" y1="50" x2="76" y2="50" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5"/>
      <text x="40" y="56" textAnchor="middle" fontFamily="Orbitron,sans-serif" fontWeight="900" fontSize="48" fill="white" letterSpacing="-2">G</text>
    </svg>
  );
}

function MechCard({ title, children, gold }) {
  return (
    <div style={{padding:20,border:`1px solid ${gold?"rgba(255,215,0,0.2)":"rgba(0,155,4,0.15)"}`,borderRadius:8,background:gold?"rgba(255,215,0,0.03)":"rgba(0,155,4,0.03)",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontFamily:"Orbitron,sans-serif",fontSize:12,fontWeight:700,letterSpacing:1,color:gold?"#FFD700":"#e0f0e8"}}>{title}</div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{height:1,background:"linear-gradient(90deg,transparent,rgba(0,155,4,0.2),transparent)"}}/>;
}

export default function HomePage() {
  const router = useRouter();
  const [scanY, setScanY] = useState(0);
  const [winner, setWinner] = useState(-1);
  const [zkStep, setZkStep] = useState(2);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeSuccess, setCodeSuccess] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const winIdx = useRef(0);
  const zkIdx = useRef(2);

  useEffect(() => {
    const s1 = setInterval(() => setScanY(p => (p + 1) % 100), 40);
    const s2 = setInterval(() => { winIdx.current = (winIdx.current + 1) % CLAIMED.length; setWinner(CLAIMED[winIdx.current]); }, 1800);
    const s3 = setInterval(() => { zkIdx.current = (zkIdx.current + 1) % 6; setZkStep(zkIdx.current); }, 1000);
    return () => { clearInterval(s1); clearInterval(s2); clearInterval(s3); };
  }, []);

  function formatCode(val) {
    let v = val.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
    if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4);
    setCode(v); setCodeError("");
  }

  function redeemCode() {
    if (!code || code.length < 9) { setCodeError("Enter a valid code in XXXX-XXXX format"); return; }
    setCodeLoading(true);
    setTimeout(() => { setCodeLoading(false); setCodeSuccess(true); }, 1200);
  }

  const ZK_STEPS = [
    "Round ends — block timestamp ≥ endTime",
    "drand network emits the pinned beacon",
    "Anyone fetches the public BLS signature",
    "resolveRound() verifies it on Robinhood",
    "Winners auto-paid in same transaction",
    "Beacon auditable forever — drand archive",
  ];

  const scanBg = `linear-gradient(180deg,transparent ${scanY-2}%,rgba(0,155,4,0.1) ${scanY-1}%,rgba(0,155,4,0.3) ${scanY}%,rgba(0,155,4,0.1) ${scanY+1}%,transparent ${scanY+2}%)`;

  return (
    <div style={{fontFamily:"'JetBrains Mono',monospace",background:"radial-gradient(ellipse at 30% 0%,#0D301A 0%,#081C0E 45%,#06140A 100%)",minHeight:"100vh",color:"#c8e5d6",position:"relative"}}>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:1,background:"repeating-linear-gradient(0deg,transparent 0px,transparent 2px,rgba(0,0,0,0.07) 2px,rgba(0,0,0,0.07) 4px)"}}/>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:2,transition:"background 0.04s linear",background:scanBg}}/>

      {/* Header */}
      <header style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",padding:"0 24px",height:56,borderBottom:"1px solid rgba(0,155,4,0.12)",background:"rgba(6,20,10,0.97)",zIndex:100,position:"sticky",top:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}} onClick={()=>router.push("/")}>
          <LogoIcon size={26}/>
          <span style={{fontFamily:"Orbitron,sans-serif",fontWeight:900,fontSize:16,color:"#00C805",letterSpacing:2}}>GR<span style={{fontWeight:500,color:"#e0f0e8"}}>OOD</span></span>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#00C805",boxShadow:"0 0 6px #00C805",animation:"pulse 2s ease-in-out infinite",marginLeft:4}}/>
        </div>
        <nav style={{display:"flex",alignItems:"center",gap:4}}>
          <button onClick={()=>router.push("/")} className="nav-btn-home" style={{background:"transparent",border:"none",fontFamily:"Orbitron,sans-serif",fontSize:10,fontWeight:700,color:"#4a6e5a",cursor:"pointer",letterSpacing:2,padding:"7px 16px",borderRadius:3,transition:"color 0.2s"}}>HOME</button>
          <button onClick={()=>router.push("/play")} className="nav-btn-play-hp" style={{background:"transparent",border:"none",fontFamily:"Orbitron,sans-serif",fontSize:10,fontWeight:700,color:"#00C805",cursor:"pointer",letterSpacing:2,padding:"7px 16px",borderRadius:3,animation:"navGlow 3s ease-in-out infinite",transition:"color 0.2s"}}>PLAY</button>
        </nav>
        <div/>
      </header>

      {/* ── HERO — single column ── */}
      <section style={{position:"relative",zIndex:5,padding:"56px 20px 40px",maxWidth:680,margin:"0 auto"}}>

        {/* Title block — centered */}
        <div style={{marginBottom:32,textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{fontSize:10,letterSpacing:3,color:"#00C805",fontWeight:700,marginBottom:14}}>● ON ROBINHOOD CHAIN</div>
          <div style={{fontFamily:"Orbitron,sans-serif",fontWeight:900,lineHeight:1.1,letterSpacing:1,marginBottom:18,fontSize:"clamp(36px,9vw,64px)"}}>
            <div style={{color:"#00C805"}}>ONCHAIN</div>
            <div style={{color:"#e0f0e8"}}>BETTING</div>
          </div>
          <div style={{fontSize:13,color:"#7a9e8b",lineHeight:1.8,marginBottom:22,maxWidth:520}}>
            Pick a cell on the 5×5 grid. A drand randomness beacon — verified on-chain — selects the winner from occupied cells only. Winners share the pot — or keep everything if they picked alone.
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
            {["1 USDG per round","30s rounds","drand beacon every round","Auto-pay on resolve"].map(c=>(
              <div key={c} style={{fontSize:10,padding:"4px 10px",borderRadius:4,background:"rgba(0,155,4,0.07)",border:"1px solid rgba(0,155,4,0.15)",color:"#7a9e8b"}}>{c}</div>
            ))}
          </div>
        </div>

        {/* Grid — centered below title */}
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginBottom:20}}>
          <div style={{position:"relative",padding:12,border:"1px solid rgba(0,155,4,0.18)",borderRadius:10,background:"rgba(8,28,14,0.7)"}}>
            {[["tl",{top:0,left:0,borderLeft:"2px solid rgba(0,155,4,0.5)",borderTop:"2px solid rgba(0,155,4,0.5)"}],
              ["tr",{top:0,right:0,borderRight:"2px solid rgba(0,155,4,0.5)",borderTop:"2px solid rgba(0,155,4,0.5)"}],
              ["bl",{bottom:0,left:0,borderLeft:"2px solid rgba(0,155,4,0.5)",borderBottom:"2px solid rgba(0,155,4,0.5)"}],
              ["br",{bottom:0,right:0,borderRight:"2px solid rgba(0,155,4,0.5)",borderBottom:"2px solid rgba(0,155,4,0.5)"}]
            ].map(([k,s])=><div key={k} style={{position:"absolute",width:14,height:14,...s}}/>)}
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,width:"min(260px, calc(100vw - 120px))"}}>
              {LBL.map((lbl,i) => {
                const isWin = i===winner, isClaimed = CLAIMED.includes(i)&&!isWin;
                return (
                  <div key={i} style={{aspectRatio:"1",borderRadius:6,border:`1px solid ${isWin?"rgba(255,215,0,0.6)":isClaimed?"rgba(0,155,4,0.55)":DARK.has(i)?"rgba(0,155,4,0.25)":OPEN.has(i)?"rgba(220,255,235,0.22)":"rgba(200,255,220,0.18)"}`,background:DARK.has(i)?"linear-gradient(145deg,#0E6022,#0A4A1A)":OPEN.has(i)?"linear-gradient(145deg,rgba(230,255,240,0.17),rgba(215,255,230,0.12))":"linear-gradient(145deg,rgba(210,255,225,0.13),rgba(190,250,210,0.08))",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:2,animation:isWin?"winnerGlow 1.5s ease-in-out infinite":"cellAppear 0.4s ease both",animationDelay:`${Math.floor(i/5)*0.06}s`,color:isWin?"#FFD700":isClaimed?"#00C805":DARK.has(i)?"rgba(140,220,170,0.4)":"rgba(210,250,225,0.6)"}}>
                    <span style={{fontSize:9,letterSpacing:1}}>{lbl}</span>
                    <span style={{fontSize:11,opacity:isWin||isClaimed?1:0.2}}>{isWin?"★":isClaimed?"◈":"◇"}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{display:"flex",gap:16,justifyContent:"center",flexWrap:"wrap"}}>
            {[["ROUND","#1"],["POT","4.00 USDG","#00C805"],["PLAYERS","4"]].map(([l,v,vc])=>(
              <div key={l} style={{fontSize:10,color:"#4a6e5a"}}>{l} <b style={{fontFamily:"Orbitron,sans-serif",fontSize:11,color:vc||"#c8e5d6"}}>{v}</b></div>
            ))}
          </div>
          <div style={{fontSize:9,letterSpacing:2,color:"#4a6e5a"}}>SIMULATION · ROBINHOOD CHAIN · DRAND SECURED</div>
        </div>

        {/* Code entry — full width below grid */}
        <div style={{width:"100%",border:"1px solid rgba(0,155,4,0.18)",borderRadius:10,background:"rgba(8,28,14,0.8)",overflow:"hidden"}}>
          {!codeSuccess ? (
            <>
              <div style={{padding:"12px 18px",borderBottom:"1px solid rgba(0,155,4,0.1)",background:"rgba(0,155,4,0.04)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,letterSpacing:2,color:"#e0f0e8"}}>GOT A CODE?</span>
                <span style={{fontSize:10,color:"#4a6e5a"}}>Redeem for free rounds</span>
              </div>
              <div style={{padding:"14px 18px",display:"flex",flexDirection:"column",gap:9}}>
                <div style={{position:"relative"}}>
                  <input type="text" value={code} placeholder="XXXX-XXXX" maxLength={9} autoComplete="off" spellCheck={false}
                    onChange={e=>formatCode(e.target.value)}
                    onFocus={()=>setShowCursor(false)}
                    onBlur={()=>{if(!code)setShowCursor(true);}}
                    onKeyDown={e=>e.key==="Enter"&&redeemCode()}
                    style={{width:"100%",background:"rgba(0,0,0,0.5)",border:`1px solid ${codeError?"rgba(255,80,0,0.5)":"rgba(0,155,4,0.2)"}`,borderRadius:7,padding:"12px",fontFamily:"Orbitron,sans-serif",fontSize:20,fontWeight:700,color:"#e0f0e8",textAlign:"center",letterSpacing:6,outline:"none",display:"block",caretColor:"#00C805"}}/>
                  {showCursor&&!code&&(
                    <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:2,height:22,background:"#00C805",animation:"caretBlink 1s step-end infinite",pointerEvents:"none"}}/>
                  )}
                </div>
                {codeError&&<div style={{fontSize:10,color:"#FF5000",textAlign:"center"}}>{codeError}</div>}
                <button onClick={redeemCode} disabled={codeLoading} style={{width:"100%",fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,padding:12,borderRadius:7,border:"none",background:"linear-gradient(135deg,#009B04,#00C805)",color:"#fff",cursor:"pointer",letterSpacing:1.5,opacity:codeLoading?0.7:1}}>
                  {codeLoading?"VERIFYING...":"REDEEM CODE"}
                </button>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{flex:1,height:1,background:"rgba(0,155,4,0.1)"}}/>
                  <span style={{fontSize:9,color:"#4a6e5a",letterSpacing:2}}>OR</span>
                  <div style={{flex:1,height:1,background:"rgba(0,155,4,0.1)"}}/>
                </div>
                <button onClick={()=>router.push("/play")} style={{width:"100%",fontFamily:"JetBrains Mono,monospace",fontSize:10,padding:10,borderRadius:6,border:"1px solid rgba(0,155,4,0.18)",background:"rgba(0,155,4,0.04)",color:"#5a7e6a",cursor:"pointer",letterSpacing:1}}>PLAY WITH USDG →</button>
              </div>
            </>
          ) : (
            <div style={{padding:"24px 18px",display:"flex",flexDirection:"column",alignItems:"center",gap:12,textAlign:"center"}}>
              <div style={{width:48,height:48,borderRadius:"50%",background:"rgba(0,200,5,0.1)",border:"2px solid rgba(0,200,5,0.4)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00C805" strokeWidth="2.5" strokeLinecap="round"><path d="M5 13l4 4L19 7"/></svg>
              </div>
              <div style={{fontFamily:"Orbitron,sans-serif",fontSize:13,fontWeight:700,letterSpacing:2,color:"#e0f0e8"}}>CODE ACTIVATED</div>
              <div style={{display:"flex",alignItems:"center",gap:12,background:"rgba(0,155,4,0.08)",border:"1px solid rgba(0,155,4,0.2)",borderRadius:8,padding:"12px 20px"}}>
                <span style={{fontFamily:"Orbitron,sans-serif",fontSize:36,fontWeight:900,color:"#00C805",lineHeight:1}}>2</span>
                <span style={{fontSize:10,color:"#c8e5d6",letterSpacing:1,lineHeight:1.5}}>Free<br/>Rounds<br/>Credited</span>
              </div>
              <button onClick={()=>router.push("/play")} style={{width:"100%",fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,padding:12,borderRadius:7,border:"none",background:"linear-gradient(135deg,#009B04,#00C805)",color:"#fff",cursor:"pointer",letterSpacing:1.5}}>ENTER THE GRID →</button>
            </div>
          )}
        </div>
      </section>

      <Divider/>

      {/* ── HOW IT WORKS ── */}
      <section id="how-section" style={{position:"relative",zIndex:5,padding:"60px 20px",maxWidth:960,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontSize:10,letterSpacing:3,color:"#00C805",fontWeight:700,marginBottom:8}}>HOW IT WORKS</div>
          <div style={{fontFamily:"Orbitron,sans-serif",fontSize:24,fontWeight:700,letterSpacing:1,color:"#e0f0e8"}}>Four Steps to Win</div>
        </div>
        <div className="steps-grid">
          {[
            {n:"01",icon:"🔐",t:"LOGIN",d:"Sign in with email, Google, or wallet. Privy creates an embedded wallet instantly — no seed phrase needed."},
            {n:"02",icon:"⬡",t:"PICK A CELL",d:"Choose any cell on the 5×5 grid. Costs 1 USDG. Multiple players can pick the same cell — they'll split if it wins."},
            {n:"03",icon:"🎲",t:"DRAND BEACON",d:"When the 30s round ends, the drand beacon pinned at round start is emitted. Its BLS signature is verified on-chain and picks the winner from occupied cells only."},
            {n:"04",icon:"💰",t:"GET PAID",d:"Winners are paid automatically during resolution. No claim step. USDG goes straight to your wallet plus $GROOD rewards."},
          ].map(({n,icon,t,d})=>(
            <div key={n} style={{padding:20,border:"1px solid rgba(0,155,4,0.15)",borderRadius:8,background:"rgba(0,155,4,0.03)",display:"flex",flexDirection:"column",gap:10}}>
              <span style={{fontFamily:"Orbitron,sans-serif",fontSize:10,fontWeight:700,color:"#009B04",background:"rgba(0,155,4,0.12)",borderRadius:4,padding:"2px 7px",display:"inline-block",letterSpacing:1,alignSelf:"flex-start"}}>{n}</span>
              <div style={{fontSize:20}}>{icon}</div>
              <div style={{fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,color:"#e0f0e8",letterSpacing:1}}>{t}</div>
              <div style={{fontSize:11,color:"#7a9e8b",lineHeight:1.7}}>{d}</div>
            </div>
          ))}
        </div>
      </section>

      <Divider/>

      {/* ── MECHANICS ── */}
      <section style={{position:"relative",zIndex:5,padding:"60px 20px",maxWidth:960,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontSize:10,letterSpacing:3,color:"#00C805",fontWeight:700,marginBottom:8}}>GAME MECHANICS</div>
          <div style={{fontFamily:"Orbitron,sans-serif",fontSize:24,fontWeight:700,letterSpacing:1,color:"#e0f0e8"}}>Know the Rules</div>
        </div>
        <div className="two-col-grid">
          <MechCard title="PAYOUT MATH">
            <p style={{fontSize:11,color:"#7a9e8b",lineHeight:1.75,margin:0}}>Every player adds 1 USDG to the pot. A 5% protocol fee and 0.1 USDG resolver reward are deducted, then the rest goes to winners on the winning cell.</p>
            <div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,155,4,0.1)",borderRadius:6,padding:"10px 12px",fontSize:11,color:"#4a6e5a",lineHeight:1.9}}>
              pool = <b style={{color:"#00C805"}}>N</b> × 1 USDG<br/>
              fee = pool × <b style={{color:"#00C805"}}>5%</b><br/>
              distributable = pool − fee − <b style={{color:"#00C805"}}>0.1 USDG</b><br/>
              each winner = distributable ÷ <b style={{color:"#00C805"}}>winners on cell</b>
            </div>
          </MechCard>
          <MechCard title="STRATEGY">
            <p style={{fontSize:11,color:"#7a9e8b",lineHeight:1.75,margin:0}}>Cells with many players give you better win odds but smaller payouts. Lonely cells pay the entire pot if they win.</p>
            <div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,155,4,0.1)",borderRadius:6,padding:"10px 12px",fontSize:11,color:"#4a6e5a",lineHeight:1.9}}>
              <span style={{color:"#4a6e5a"}}>{`// 20 players, 3 on winning cell`}</span><br/>
              pool = <b style={{color:"#00C805"}}>20 USDG</b><br/>
              distributable ≈ <b style={{color:"#00C805"}}>18.9 USDG</b><br/>
              each winner = <b style={{color:"#00C805"}}>+6.30 USDG</b>
            </div>
          </MechCard>
          <MechCard title="$GROOD REWARDS">
            <p style={{fontSize:11,color:"#7a9e8b",lineHeight:1.75,margin:0}}>Every resolved round mints <b style={{color:"#e0f0e8"}}>$GROOD tokens</b> to winners on top of USDG. TGE is deferred until meaningful user milestones — it&apos;s a gameplay reward, not a speculative asset.</p>
          </MechCard>
          <MechCard title="🔥 MOTHERLODE ROUNDS" gold>
            <p style={{fontSize:11,color:"#7a9e8b",lineHeight:1.75,margin:0}}>1 in 100 rounds is a Motherlode. Winners get <b style={{color:"#FFD700"}}>10× the normal USDG payout</b> plus 10× $GROOD emission. Determined by a secondary hash of the drand beacon.</p>
          </MechCard>
        </div>
      </section>

      <Divider/>

      {/* ── $GROOD ── */}
      <section style={{position:"relative",zIndex:5,padding:"60px 20px",maxWidth:960,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontSize:10,letterSpacing:3,color:"#00C805",fontWeight:700,marginBottom:8}}>TOKEN</div>
          <div style={{fontFamily:"Orbitron,sans-serif",fontSize:24,fontWeight:700,letterSpacing:1,color:"#e0f0e8"}}>$GROOD</div>
        </div>
        <div className="four-col-grid" style={{marginBottom:16}}>
          {[
            {l:"SUPPLY MODEL",v:"EMISSION-ONLY",s:"No pre-mine — minted only to round winners",bc:"rgba(0,155,4,0.15)",bg:"rgba(0,155,4,0.04)",vs:15},
            {l:"EMISSION / ROUND",v:"100",s:"$GROOD split among winning cell players",bc:"rgba(0,155,4,0.15)",bg:"rgba(0,155,4,0.04)",vc:"#00C805"},
            {l:"MOTHERLODE",v:"1000",s:"10× emission on bonus rounds (1 in 100)",bc:"rgba(255,215,0,0.15)",bg:"rgba(255,215,0,0.03)",vc:"#FFD700"},
            {l:"TGE",v:"DEFERRED",s:"Unlocks only after meaningful user milestones",bc:"rgba(0,200,5,0.15)",bg:"rgba(0,200,5,0.03)",vc:"#00C805",vs:15},
          ].map(({l,v,s,bc,bg,vc,vs})=>(
            <div key={l} style={{padding:16,border:`1px solid ${bc}`,borderRadius:8,background:bg,display:"flex",flexDirection:"column",gap:6}}>
              <div style={{fontSize:9,letterSpacing:2,color:"#4a6e5a",fontWeight:700}}>{l}</div>
              <div style={{fontFamily:"Orbitron,sans-serif",fontSize:vs||20,fontWeight:900,color:vc||"#e0f0e8",lineHeight:1.2}}>{v}</div>
              <div style={{fontSize:10,color:"#7a9e8b"}}>{s}</div>
            </div>
          ))}
        </div>
        <div className="two-col-grid">
          <div style={{padding:20,border:"1px solid rgba(0,155,4,0.15)",borderRadius:8,background:"rgba(0,155,4,0.03)",display:"flex",flexDirection:"column",gap:12}}>
            <div style={{fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,letterSpacing:1,color:"#e0f0e8"}}>HOW YOU EARN</div>
            {[
              {n:"01",text:<>Pick the winning cell — <b style={{color:"#e0f0e8"}}>100 $GROOD</b> split among all players on that cell</>},
              {n:"02",text:<>Pick alone on winning cell — keep the entire <b style={{color:"#e0f0e8"}}>100 $GROOD</b> yourself</>},
              {n:"🔥",text:<>Win a Motherlode — earn <b style={{color:"#FFD700"}}>1000 $GROOD</b> on top of 10× USDG</>,gold:true},
            ].map(({n,text,gold})=>(
              <div key={n} style={{display:"flex",alignItems:"flex-start",gap:10,fontSize:11,color:"#7a9e8b",lineHeight:1.6}}>
                <span style={{fontFamily:"Orbitron,sans-serif",fontSize:9,color:gold?"#FFD700":"#009B04",background:gold?"rgba(255,215,0,0.08)":"rgba(0,155,4,0.12)",padding:"2px 6px",borderRadius:3,flexShrink:0,marginTop:2}}>{n}</span>
                <span>{text}</span>
              </div>
            ))}
          </div>
          <div style={{padding:20,border:"1px solid rgba(0,155,4,0.15)",borderRadius:8,background:"rgba(0,155,4,0.03)",display:"flex",flexDirection:"column",gap:12}}>
            <div style={{fontFamily:"Orbitron,sans-serif",fontSize:11,fontWeight:700,letterSpacing:1,color:"#e0f0e8"}}>TGE TERMS</div>
            <div style={{fontSize:11,color:"#7a9e8b",lineHeight:1.8}}>The TGE is <b style={{color:"#e0f0e8"}}>intentionally deferred</b> until Grood reaches meaningful player milestones. $GROOD earned now accumulates in your wallet.</div>
            <div style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(0,155,4,0.1)",borderRadius:6,padding:"10px 12px",fontSize:11,color:"#4a6e5a",lineHeight:1.8}}>
              <b style={{color:"#00C805"}}>$GROOD is a gameplay reward</b> — not a speculative asset. Utility will be defined before TGE.
            </div>
          </div>
        </div>
      </section>

      <Divider/>

      {/* ── ZK PROOF ── */}
      <section style={{position:"relative",zIndex:5,padding:"60px 20px",maxWidth:960,margin:"0 auto"}}>
        <div style={{border:"1px solid rgba(0,155,4,0.15)",borderRadius:10,background:"rgba(0,155,4,0.03)",padding:"32px 28px",display:"flex",flexDirection:"column",gap:32}}>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{fontSize:10,letterSpacing:3,color:"#00C805",fontWeight:700}}>PROVABLY FAIR</div>
            <div style={{fontFamily:"Orbitron,sans-serif",fontSize:20,fontWeight:700,color:"#e0f0e8",letterSpacing:1,lineHeight:1.3}}>Distributed Randomness Every Round</div>
            <div style={{fontSize:11,color:"#7a9e8b",lineHeight:1.8}}>Every winner is drawn from a drand beacon — randomness produced by the League of Entropy&apos;s distributed network. The beacon for each round doesn&apos;t exist until after betting closes, and the game contract verifies its BLS signature itself. Nobody — not even the resolver — can bias the outcome.</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {["DRAND EVMNET","BLS BN254","3S BEACONS"].map(p=><span key={p} style={{fontSize:9,padding:"3px 8px",borderRadius:3,fontWeight:700,letterSpacing:1,background:"rgba(0,155,4,0.12)",color:"#00C805",border:"1px solid rgba(0,155,4,0.2)"}}>{p}</span>)}
              {["VERIFIED ON-CHAIN","LEAGUE OF ENTROPY"].map(p=><span key={p} style={{fontSize:9,padding:"3px 8px",borderRadius:3,fontWeight:700,letterSpacing:1,background:"rgba(0,200,5,0.1)",color:"#00C805",border:"1px solid rgba(0,200,5,0.2)"}}>{p}</span>)}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {ZK_STEPS.map((label,i)=>{
              const done=i<zkStep,active=i===zkStep;
              return (
                <div key={i}>
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:6,border:`1px solid ${active?"rgba(0,155,4,0.2)":done?"rgba(0,200,5,0.15)":"transparent"}`,background:active?"rgba(0,155,4,0.06)":done?"rgba(0,200,5,0.04)":"transparent",transition:"all 0.3s"}}>
                    <div style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:active?"#00C805":done?"#00C805":"rgba(0,155,4,0.2)",boxShadow:active?"0 0 6px #00C805":"none",animation:active?"pulse 1.5s ease-in-out infinite":"none"}}/>
                    <span style={{fontSize:11,color:active?"#00C805":done?"#00C805":"#4a6e5a",fontWeight:active||done?600:400}}>{label}</span>
                  </div>
                  {i<ZK_STEPS.length-1&&<div style={{width:1,height:8,background:"rgba(0,155,4,0.15)",marginLeft:16}}/>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,padding:"16px 24px",borderTop:"1px solid rgba(0,155,4,0.08)",background:"rgba(6,20,10,0.97)",zIndex:10,position:"relative"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <LogoIcon size={16}/>
          <span style={{fontFamily:"Orbitron,sans-serif",fontSize:10,fontWeight:700,color:"#00C805",letterSpacing:1.5,animation:"scanGlow 3s ease-in-out infinite"}}>GROOD ONLINE</span>
        </div>
        <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
          <a href="https://x.com/gridzerogg" target="_blank" rel="noopener noreferrer"
            style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:"#5a7e6a",textDecoration:"none",letterSpacing:1,padding:"4px 10px",borderRadius:4,border:"1px solid rgba(255,255,255,0.07)",background:"rgba(255,255,255,0.02)"}}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            @gridzerogg
          </a>
          {process.env.NEXT_PUBLIC_GROOD_ADDR && (
            <a href={`https://robinhoodchain.blockscout.com/address/${process.env.NEXT_PUBLIC_GROOD_ADDR}`} target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:"#3a5e4a",textDecoration:"none",letterSpacing:1}}>CONTRACT</a>
          )}
          <a href="https://drand.love" target="_blank" rel="noopener noreferrer" style={{fontSize:10,color:"#3a5e4a",textDecoration:"none",letterSpacing:1}}>DRAND</a>
        </div>
        <div style={{fontSize:10,color:"#2a4e3a",letterSpacing:1}}>ON-CHAIN · ROBINHOOD · DRAND</div>
      </footer>

      <style>{`
        @keyframes cellAppear{from{opacity:0;transform:scale(0.9)}to{opacity:1;transform:scale(1)}}
        @keyframes winnerGlow{0%,100%{box-shadow:0 0 10px rgba(255,200,0,0.35)}50%{box-shadow:0 0 28px rgba(255,200,0,0.75)}}
        @keyframes scanGlow{0%,100%{text-shadow:0 0 4px #00C805}50%{text-shadow:0 0 12px #00C805}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.35}}
        @keyframes caretBlink{0%,100%{opacity:1}50%{opacity:0}}
        .nav-btn-home:hover{color:#00C805!important}
        .nav-btn-play-hp:hover{color:#26D02B!important}

        @keyframes navGlow{0%,100%{text-shadow:0 0 6px rgba(0,200,5,0.5)}50%{text-shadow:0 0 14px rgba(0,200,5,0.9)}}
        @keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 4px #00C805}50%{opacity:0.4;box-shadow:0 0 10px #00C805}}
        *{box-sizing:border-box}
        input::placeholder{color:#1e422e}
        .steps-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
        .two-col-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
        .four-col-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
        @media(max-width:700px){
          .steps-grid{grid-template-columns:1fr 1fr}
          .two-col-grid{grid-template-columns:1fr}
          .four-col-grid{grid-template-columns:1fr 1fr}
        }
        @media(max-width:420px){
          .steps-grid{grid-template-columns:1fr}
          .four-col-grid{grid-template-columns:1fr}
        }

      `}</style>
    </div>
  );
}
