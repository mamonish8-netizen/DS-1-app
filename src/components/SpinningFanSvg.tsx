import { useEffect, useRef } from "react";

interface SpinningFanSvgProps {
  rpm: number;
  className?: string;
  accent?: "cool" | "thermal";
}

export function SpinningFanSvg({ rpm, className = "w-28 h-28 sm:w-36 sm:h-36 lg:w-44 lg:h-44", accent = "cool" }: SpinningFanSvgProps) {
  const rotorRef = useRef<SVGGElement | null>(null);
  const angleRef = useRef<number>(0);
  const rpmRef = useRef<number>(rpm);

  useEffect(() => {
    rpmRef.current = rpm;
  }, [rpm]);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    let rafId = 0;
    let lastTime = performance.now();

    const animate = (now: number) => {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;

      const degPerSec = Math.min(720, Math.max(45, (rpmRef.current / 60) * 16));
      angleRef.current = (angleRef.current + degPerSec * dt) % 360;

      if (rotorRef.current) {
        rotorRef.current.setAttribute("transform", `rotate(${angleRef.current.toFixed(1)} 100 100)`);
      }

      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const strokeColor = accent === "cool" ? "#38BDF8" : "#F97316";
  const blades = [0, 40, 80, 120, 160, 200, 240, 280, 320];

  return (
    <svg
      viewBox="0 0 200 200"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="100" cy="100" r="94" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="1.5" />
      <circle
        cx="100"
        cy="100"
        r="86"
        stroke={strokeColor}
        strokeOpacity="0.45"
        strokeWidth="1.5"
        strokeDasharray="6 6"
      />

      <g ref={rotorRef} transform="rotate(0 100 100)">
        {blades.map((deg) => (
          <path
            key={deg}
            d="M100 100 L122 46 L166 40 L132 86 Z"
            fill={strokeColor}
            fillOpacity="0.2"
            stroke={strokeColor}
            strokeOpacity="0.7"
            strokeWidth="1.2"
            transform={`rotate(${deg} 100 100)`}
          />
        ))}
        <circle cx="100" cy="100" r="22" fill="#050810" stroke={strokeColor} strokeWidth="2" />
        <circle cx="100" cy="100" r="8" fill={strokeColor} />
      </g>
    </svg>
  );
}
