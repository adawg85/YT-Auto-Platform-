/**
 * Icon set: lucide-react, re-exported under stable local names so pages never
 * import the library directly. Sizing comes from CSS context (nav, .btn,
 * .chip, .panel-head…), stroke width is unified for the wireframe look.
 */
import {
  Activity,
  Bell,
  Bot,
  CalendarClock,
  Check,
  CircleDollarSign,
  Eye,
  Gauge,
  Timer,
  TrendingDown,
  TrendingUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Inbox,
  LayoutDashboard,
  Maximize2,
  Megaphone,
  Menu,
  MonitorPlay,
  MoreHorizontal,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings,
  Sparkles,
  TriangleAlert,
  Upload,
  Users,
  X,
  Zap,
  type LucideProps,
} from "lucide-react";

type P = { className?: string };
const w = (Icon: React.ComponentType<LucideProps>, extra?: Partial<LucideProps>) => {
  const Wrapped = (p: P) => <Icon strokeWidth={1.8} {...extra} {...p} />;
  return Wrapped;
};

export const IconOverview = w(LayoutDashboard);
export const IconChannels = w(MonitorPlay);
export const IconReview = w(ClipboardCheck);
export const IconMarketing = w(Megaphone);
export const IconUgc = w(Users);
export const IconAssistant = w(Bot);
export const IconAccount = w(Settings);
export const IconPlus = w(Plus, { strokeWidth: 2 });
export const IconChevronLeft = w(ChevronLeft, { strokeWidth: 2 });
export const IconChevronRight = w(ChevronRight, { strokeWidth: 2 });
export const IconChevronDown = w(ChevronDown, { strokeWidth: 2 });
export const IconBell = w(Bell);
export const IconMoon = w(Moon);
export const IconMenu = w(Menu);
export const IconMore = w(MoreHorizontal, { strokeWidth: 2 });
export const IconSparkle = w(Sparkles);
export const IconCheck = w(Check, { strokeWidth: 2.2 });
export const IconZap = w(Zap);
export const IconRefresh = w(RefreshCw);
export const IconX = w(X, { strokeWidth: 2.2 });
export const IconSend = w(SendHorizontal);
export const IconUpload = w(Upload);
export const IconCalendar = w(CalendarClock);
export const IconExpand = w(Maximize2, { strokeWidth: 2 });
export const IconAlertTriangle = w(TriangleAlert);
export const IconInbox = w(Inbox);
export const IconExternal = w(ExternalLink);
export const IconSearch = w(Search);
export const IconFileText = w(FileText);
export const IconFilm = w(Clapperboard);
export const IconEye = w(Eye);
export const IconGauge = w(Gauge);
export const IconActivity = w(Activity);
export const IconDollar = w(CircleDollarSign);
export const IconTimer = w(Timer);
export const IconTrendDown = w(TrendingDown);
export const IconTrend = w(TrendingUp);
/** Filled play triangle — used on brand marks and video tiles. */
export const IconPlay = ({ className }: P) => (
  <Play className={className} fill="currentColor" strokeWidth={1} />
);
