import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import Home from './pages/Home';
// Side-effect import: deckStore runs the one-time localStorage legacy-deck migration at module
// load. Without this, the store module only loads when a page that uses it is visited (DeckBuilder/
// Battle are lazy-loaded), so a user landing on Home would never get migrated — caught by e2e.
import './stores/deckStore';

const CardBrowser = lazy(() => import('./pages/CardBrowser'));
const DeckBuilder = lazy(() => import('./pages/DeckBuilder'));
const Battle = lazy(() => import('./pages/Battle'));
const BattleLab = lazy(() => import('./pages/BattleLab'));

const navLinks = [
  { to: '/', label: '首頁' },
  { to: '/cards', label: '卡牌瀏覽' },
  { to: '/deck', label: '牌組構築' },
  { to: '/battle', label: '對戰' },
  { to: '/lab', label: 'AI 實驗室' },
];

function NavBar() {
  const location = useLocation();

  return (
    // Stays single-line at every width (horizontal scroll on the link row instead of wrapping) —
    // Battle.tsx's board sizes itself off `h-[calc(100vh-7rem)]`, which assumes a fixed one-line
    // nav height; letting the links wrap on a narrow phone would silently break that math.
    <nav className="bg-slate-800 border-b border-slate-700 px-3 sm:px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center gap-3 sm:gap-6">
        <span className="text-xl font-bold text-yellow-400 flex-shrink-0">PTCG</span>
        <div className="flex gap-1 sm:gap-4 overflow-x-auto">
          {navLinks.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`flex-shrink-0 px-2.5 sm:px-3 py-1.5 rounded text-sm font-medium transition-colors whitespace-nowrap ${
                location.pathname === to
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-300 hover:text-white hover:bg-slate-700'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500" />
    </div>
  );
}

// Home gets a light theme (see tailwind.config.js's `home.*` tokens) while every other page keeps
// the dark battle-table look — this needs the current route, so it has to live inside
// <BrowserRouter> rather than in App() itself (useLocation isn't available above the Router).
function AppShell() {
  const isHome = useLocation().pathname === '/';
  return (
    <div className={`min-h-screen ${isHome ? 'bg-home-bg' : 'bg-slate-900'}`}>
      <NavBar />
      <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3 sm:py-6">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/cards" element={<CardBrowser />} />
            <Route path="/deck" element={<DeckBuilder />} />
            <Route path="/battle" element={<Battle />} />
            <Route path="/battle/:id" element={<Battle />} />
            <Route path="/lab" element={<BattleLab />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
