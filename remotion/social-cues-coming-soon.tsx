import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type ComingSoonProps = {
  brandName: string;
  headline: string;
  subhead: string;
  footer: string;
  variant?: "square" | "vertical" | "story" | "thumbnail";
};

const colors = {
  void: "#08080f",
  grid: "#0f0f1a",
  deep: "#1a1a2e",
  signal: "#ff2d78",
  signalDeep: "#cc0055",
  text: "#ffffff",
  muted: "rgba(255,255,255,0.52)",
  rule: "rgba(255,45,120,0.18)",
  ghost: "rgba(255,45,120,0.10)",
  glow: "rgba(255,45,120,0.25)",
  success: "#00e5a0",
};

const dotData = [
  [32, 32, 0.35],
  [60, 32, 0.65],
  [88, 32, 0.25],
  [32, 60, 0.7],
  [60, 60, 1],
  [88, 60, 0.5],
  [32, 88, 0.2],
  [60, 88, 0.45],
  [88, 88, 0.75],
] as const;

const lineData = [
  [32, 32, 60, 60, 0.32],
  [60, 60, 88, 32, 0.32],
  [60, 60, 88, 88, 0.32],
  [60, 60, 32, 88, 0.32],
  [32, 32, 32, 88, 0.12],
  [88, 32, 88, 88, 0.12],
  [32, 32, 88, 32, 0.12],
  [32, 88, 88, 88, 0.12],
] as const;

const ConstellationMark: React.FC<{size: number; frame: number}> = ({size, frame}) => {
  const lineReveal = interpolate(frame, [8, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dotReveal = interpolate(frame, [32, 74], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pulse = Math.sin(frame / 10) * 0.5 + 0.5;

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      style={{
        filter: `drop-shadow(0 0 ${18 + pulse * 22}px ${colors.glow})`,
        overflow: "visible",
      }}
    >
      <rect
        x="14"
        y="14"
        width="92"
        height="92"
        rx="18"
        fill={colors.grid}
        stroke={colors.signal}
        strokeOpacity={0.38}
        strokeWidth={1.2}
      />
      {lineData.map(([x1, y1, x2, y2, opacity], index) => (
        <line
          key={`line-${index}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={colors.signal}
          strokeWidth={index < 4 ? 1.25 : 0.7}
          strokeLinecap="round"
          opacity={opacity * lineReveal}
        />
      ))}
      {dotData.map(([cx, cy, targetOpacity], index) => {
        const isCenter = cx === 60 && cy === 60;
        const localReveal = interpolate(dotReveal, [index * 0.04, 0.55 + index * 0.04], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <circle
            key={`dot-${index}`}
            cx={cx}
            cy={cy}
            r={isCenter ? 12 + pulse * 1.5 : 5}
            fill={colors.signal}
            opacity={targetOpacity * localReveal}
          />
        );
      })}
    </svg>
  );
};

export const SocialCuesComingSoon: React.FC<ComingSoonProps> = ({
  brandName,
  headline,
  subhead,
  footer,
  variant = "square",
}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const isVertical = height > width;
  const isWide = width > height;
  const entrance = spring({frame, fps, config: {damping: 18, stiffness: 92}});
  const gridShift = interpolate(frame, [0, 180], [0, isVertical ? 42 : 28]);
  const contentLift = variant === "story" ? -84 : isVertical ? -20 : isWide ? 0 : 0;
  const markSize = isVertical ? 190 : isWide ? 122 : 152;
  const eyebrowSize = isVertical ? 25 : isWide ? 17 : 19;
  const brandSize = isVertical ? 86 : isWide ? 62 : 76;
  const headlineSize = isVertical ? 58 : isWide ? 44 : 52;
  const subheadSize = isVertical ? 41 : isWide ? 30 : 36;
  const footerSize = isVertical ? 28 : isWide ? 20 : 23;
  const maxWidth = isVertical ? 920 : isWide ? 1080 : 900;
  const titleOpacity = interpolate(frame, [42, 76], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleY = interpolate(frame, [42, 90, 180], [28, 0, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const footerOpacity = interpolate(frame, [105, 134], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const railOpacity = interpolate(frame, [18, 58], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: colors.void,
        color: colors.text,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `
            linear-gradient(${colors.rule} 1px, transparent 1px),
            linear-gradient(90deg, ${colors.rule} 1px, transparent 1px)
          `,
          backgroundSize: "60px 60px",
          backgroundPosition: `${gridShift}px ${gridShift}px`,
          opacity: 0.42,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 50% ${isVertical ? "37%" : "43%"}, rgba(255,45,120,0.18) 0%, transparent 55%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: isWide ? 86 : 42,
          right: isWide ? 86 : 42,
          top: isVertical ? 150 : isWide ? 86 : 96,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${colors.signal}, transparent)`,
          opacity: railOpacity,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: isWide ? 86 : 42,
          right: isWide ? 86 : 42,
          bottom: isVertical ? 170 : isWide ? 82 : 96,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${colors.signal}, transparent)`,
          opacity: railOpacity * 0.82,
        }}
      />
      <div
        style={{
          position: "relative",
          zIndex: 2,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: isVertical ? "96px 74px" : isWide ? "70px 86px" : "86px 74px",
          textAlign: "center",
          transform: `translateY(${contentLift}px)`,
        }}
      >
        <div
          style={{
            transform: `scale(${interpolate(entrance, [0, 1], [0.72, 1])})`,
            marginBottom: isVertical ? 44 : isWide ? 24 : 34,
          }}
        >
          <ConstellationMark size={markSize} frame={frame} />
        </div>

        <div
          style={{
            opacity: titleOpacity,
            transform: `translateY(${titleY}px)`,
            maxWidth,
          }}
        >
          <div
            style={{
              fontSize: eyebrowSize,
              fontWeight: 760,
              letterSpacing: isVertical ? 8 : 6,
              textTransform: "uppercase",
              color: colors.signal,
              marginBottom: isVertical ? 28 : isWide ? 16 : 22,
            }}
          >
            The Social Media Command Platform
          </div>

          <div
            style={{
              fontSize: brandSize,
              fontWeight: 930,
              letterSpacing: isWide ? -2 : -3,
              lineHeight: 0.96,
              marginBottom: isVertical ? 38 : isWide ? 22 : 30,
              textShadow: "0 0 34px rgba(255,45,120,0.14)",
            }}
          >
            Social{" "}
            <span style={{color: colors.signal}}>Cues</span>
            <span style={{color: colors.text}}> App</span>
          </div>

          <div
            style={{
              fontSize: headlineSize,
              fontWeight: 900,
              lineHeight: 1.02,
              letterSpacing: isWide ? -1 : -2,
              marginBottom: isVertical ? 20 : 14,
            }}
          >
            <span style={{color: colors.text}}>Create. Schedule. </span>
            <span style={{color: colors.signal}}>Conquer.</span>
          </div>

          <div
            style={{
              fontSize: subheadSize,
              fontWeight: 720,
              color: colors.muted,
              letterSpacing: 0,
              lineHeight: 1.18,
            }}
          >
            {subhead}
          </div>
        </div>

        <div
          style={{
            marginTop: isVertical ? 54 : isWide ? 30 : 42,
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            padding: isVertical ? "18px 30px" : "14px 24px",
            borderRadius: 8,
            border: `1px solid ${colors.rule}`,
            background: colors.ghost,
            color: colors.signal,
            fontSize: footerSize,
            fontWeight: 850,
            letterSpacing: isVertical ? 5 : 4,
            textTransform: "uppercase",
            opacity: footerOpacity,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: colors.signal,
              boxShadow: `0 0 18px ${colors.signal}`,
            }}
          />
          {footer}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: colors.signal,
              boxShadow: `0 0 18px ${colors.signal}`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
