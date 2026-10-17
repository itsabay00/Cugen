import { Plus, Info, Warning, CheckCircle, XCircle, CircleNotch } from "@phosphor-icons/react";
import { colors, semantic } from "../lib/colors.js";

export function Card({ children, className = "", style = {} }) {
  return (
    <div className={`rounded-lg ${className}`} style={{ backgroundColor: colors.white, border: `1px solid ${colors.border}`, ...style }}>
      {children}
    </div>
  );
}

// `filled` is for pills that sit on a grey card, where a grey outline would disappear.
export function OutlinePill({ label, filled = false }) {
  return (
    <span
      className="inline-flex items-center px-3 py-1 rounded-full text-xs font-normal shrink-0"
      style={filled ? { backgroundColor: colors.white, color: colors.ink } : { border: `1px solid ${colors.border}`, color: colors.ink }}
    >
      {label}
    </span>
  );
}

export function IconPill({ icon: Icon, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-normal shrink-0" style={{ backgroundColor: colors.lightGray, color: colors.ink }}>
      {Icon && <Icon className="w-3 h-3 shrink-0" weight="regular" />}
      {label}
    </span>
  );
}

export function PrimaryButton({ children, onClick, disabled, className = "", type = "button", ...rest }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rsv-btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-normal disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled, className = "", ...rest }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rsv-btn-ghost inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs sm:text-sm font-normal disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({ children, onClick, className = "", ariaLabel }) {
  return (
    <button onClick={onClick} aria-label={ariaLabel} className={`p-2 rounded-full rsv-icon-btn ${className}`} style={{ color: colors.gray }}>
      {children}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: colors.lightGray }}>
        <Icon className="w-6 h-6" style={{ color: colors.ink }} />
      </div>
      <h3 className="text-sm font-medium" style={{ color: colors.black }}>{title}</h3>
      <p className="text-sm mt-1 max-w-xs" style={{ color: colors.gray }}>{description}</p>
      {action && (
        <PrimaryButton onClick={action.onClick} className="mt-5">
          <Plus className="w-4 h-4" />
          {action.label}
        </PrimaryButton>
      )}
    </div>
  );
}

const BANNER_ICON = { error: XCircle, warning: Warning, success: CheckCircle, info: Info };

// Semantic banner — error / warning / success / info, using the exact colors given.
export function Banner({ kind = "info", message, onRetry, className = "", children, testId }) {
  const c = semantic[kind] || semantic.info;
  const Icon = BANNER_ICON[kind] || Info;
  // Yellow text on a pale-yellow fill is nearly unreadable (about 1.6:1), so warnings keep the exact
  // yellow on the icon and fill but set the words in the dark ink colour. The other three use their own colour.
  const textColor = kind === "warning" ? colors.ink : c.fg;
  return (
    <div className={`flex items-start gap-3 rounded-lg p-4 ${className}`} style={{ backgroundColor: c.bg }} data-testid={testId} role={kind === "error" ? "alert" : "status"}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" weight="fill" style={{ color: c.fg }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm break-words" style={{ color: textColor }}>{message}</p>
        {children}
        {onRetry && (
          <button onClick={onRetry} className="text-sm font-medium mt-1 underline" style={{ color: textColor }}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// Kept for any call sites still using the old name — same as Banner kind="error".
export function ErrorBanner({ message, onRetry, className = "" }) {
  return <Banner kind="error" message={message} onRetry={onRetry} className={className} />;
}

// Floats at the top of the screen while the app is looking for the next case, so it shows on a phone
// (where the case list is hidden behind the chat) as well as on a computer.
export function QueueToast({ source, onCancel }) {
  const text = source === "auto" ? "Case handled — looking for your next one…" : "Searching for the next case…";
  return (
    <div className="fixed top-3 left-1/2 z-50 w-[calc(100vw-24px)] max-w-[420px]" style={{ transform: "translateX(-50%)" }}>
      <div
        className="flex items-center gap-3 rounded-lg px-4 py-3"
        style={{ backgroundColor: semantic.info.bg, boxShadow: "0 4px 16px rgba(0,0,0,0.08)" }}
        role="status"
        aria-live="polite"
        data-testid="queue-toast"
      >
        <CircleNotch className="w-4 h-4 shrink-0 animate-spin" style={{ color: semantic.info.fg }} />
        <p className="flex-1 min-w-0 text-sm" style={{ color: colors.ink }}>{text}</p>
        <button onClick={onCancel} className="text-sm font-medium underline shrink-0" style={{ color: colors.ink }} data-testid="queue-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
