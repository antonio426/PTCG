import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import Home from './pages/Home';

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
    <nav className="bg-slate-800 border-b border-slate-700 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center gap-6">
        <span className="text-xl font-bold text-yellow-400">PTCG</span>
        <div className="flex gap-4">
          {navLinks.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
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
      <main className="max-w-7xl mx-auto px-4 py-6">
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
