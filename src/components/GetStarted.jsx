import { colors } from "../lib/colors.js";
import { Card } from "./ui.jsx";
import { CaseCard } from "./CaseListView.jsx";

const STEPS = [
  {
    title: "Get cases",
    description: "Pull the next customer case, or paste one in with any order number, SKU, tracking details or photos the customer sent.",
  },
  {
    title: "Get resolutions",
    description: "The assistant reads the case and drafts a reply from your knowledge base. Chat with it to refine the draft.",
  },
  {
    title: "Forward to customers",
    description: "Send the finished reply by email, WhatsApp or text message, then track the case by status.",
  },
];

export default function GetStarted({ onStart, searching = false, cases = [], onSelectCase, onSeeHistory }) {
  const recent = cases.slice(0, 3);

  return (
    <div>
      <div className="flex flex-col gap-[16px] mb-[40px]">
        <div className="w-[44px] h-[44px] rounded-full" style={{ backgroundColor: colors.lightGray }} />
        <h2 className="text-[20px] font-medium tracking-[-0.4px]" style={{ color: colors.black }}>Welcome, Bless</h2>
      </div>

      <div className="flex flex-wrap gap-[20px]">
        {STEPS.map((step) => (
          <Card key={step.title} className="w-[200px] shrink-0 overflow-hidden">
            <div className="h-[120px] w-full" style={{ backgroundColor: colors.bg }} />
            <div className="flex flex-col gap-[4px] p-[12px] text-[12px]">
              <span className="font-normal" style={{ color: colors.black }}>{step.title}</span>
              <span className="font-normal" style={{ color: colors.gray }}>{step.description}</span>
            </div>
          </Card>
        ))}
      </div>

      <button onClick={onStart} disabled={searching} className="text-sm font-normal underline mt-6 disabled:no-underline disabled:opacity-60" style={{ color: colors.ink }} data-testid="get-first-case">
        {searching ? "Searching for a case…" : cases.length ? "Get the next case →" : "Get your first case →"}
      </button>

      {recent.length > 0 && (
        <div className="mt-10 max-w-[640px]" data-testid="recent-history">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium" style={{ color: colors.gray }}>Recent history</p>
            <button onClick={onSeeHistory} className="text-xs font-medium underline" style={{ color: colors.ink }}>
              See all history →
            </button>
          </div>
          <div className="flex flex-col gap-2">
            {recent.map((c) => (
              <CaseCard key={c.id} item={c} selected={false} onClick={() => onSelectCase && onSelectCase(c.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
