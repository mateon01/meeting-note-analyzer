import { NavLink } from "react-router";
import { IconChat, IconMeetings, IconSettings, IconUpload, IconStudy, IconUsers } from "./icons";

const tabs = [
  { to: "/", label: "회의", Icon: IconMeetings },
  { to: "/lectures", label: "강의", Icon: IconStudy },
  { to: "/interviews", label: "인터뷰", Icon: IconUsers },
  { to: "/upload", label: "업로드", Icon: IconUpload },
  { to: "/chat", label: "챗봇", Icon: IconChat, beta: true },
  { to: "/settings", label: "설정", Icon: IconSettings },
];

export function TabBar() {
  return (
    <nav className="shrink-0 bg-surface border-t border-line safe-bottom">
      <ul className="flex">
        {tabs.map(({ to, label, Icon, beta }) => (
          <li key={to} className="flex-1">
            <NavLink to={to} end={to === "/"} className={({ isActive }) => `tap flex flex-col items-center justify-center h-[58px] gap-1 text-[11px] font-medium transition-colors ${isActive ? "text-accent" : "text-ink-3"}`}>
              {({ isActive }) => (
                <>
                  <span className={`relative grid h-7 w-12 place-items-center rounded-full transition-colors ${isActive ? "bg-accent-soft" : ""}`}>
                    <Icon size={22} strokeWidth={isActive ? 2 : 1.75} />
                    {beta && <span className="absolute -right-2 -top-1 rounded-[4px] bg-violet px-1 text-[8px] font-bold leading-[13px] tracking-wide text-white">BETA</span>}
                  </span>
                  {label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
