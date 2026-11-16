import {
  Activity,
  Compass,
  Cpu,
  Crosshair,
  Flame,
  Gauge,
  Layers,
  Scale,
  Shield,
  Snowflake,
  VolumeX,
  Zap,
} from "lucide-react";

interface ProfileSymbolProps {
  name: string;
  className?: string;
}

const CUSTOM_ICONS = [Gauge, Cpu, Zap, Shield, Compass, Layers, Crosshair, Activity];

export function ProfileSymbol({ name, className = "h-4 w-4" }: ProfileSymbolProps) {
  const key = name.trim().toLowerCase();

  if (key === "silent" || key.includes("quiet") || key.includes("eco")) {
    return <VolumeX className={`${className} text-[#38BDF8]`} aria-hidden="true" />;
  }
  if (key === "balanced" || key.includes("default") || key.includes("auto")) {
    return <Scale className={`${className} text-white`} aria-hidden="true" />;
  }
  if (key === "performance" || key.includes("boost") || key.includes("turbo") || key.includes("overclock")) {
    return <Flame className={`${className} text-[#F97316]`} aria-hidden="true" />;
  }
  if (key === "extreme cooling" || key.includes("cool") || key.includes("max") || key.includes("ice")) {
    return <Snowflake className={`${className} text-[#38BDF8]`} aria-hidden="true" />;
  }

  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const Icon = CUSTOM_ICONS[hash % CUSTOM_ICONS.length];
  return <Icon className={`${className} text-[#F97316]`} aria-hidden="true" />;
}
