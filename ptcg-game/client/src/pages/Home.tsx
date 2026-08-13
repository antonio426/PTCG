import { Link } from 'react-router-dom';

interface FeatureCard {
  title: string;
  description: string;
  path: string;
  icon: string;
}

const features: FeatureCard[] = [
  {
    title: '卡牌瀏覽',
    description: '瀏覽所有 PTCG 卡牌，搜尋特定卡片，查看詳細資訊',
    path: '/cards',
    icon: '🃏',
  },
  {
    title: '牌組構築',
    description: '建立和編輯你的牌組，檢查牌組合法性',
    path: '/deck',
    icon: '⚔️',
  },
  {
    title: 'AI 對戰練習',
    description: '與 AI 對手進行對戰，磨練你的牌技',
    path: '/battle',
    icon: '🤖',
  },
  {
    title: 'AI 牌組實驗室',
    description: '觀看兩個 AI 互相比賽，測試牌組實力',
    path: '/lab',
    icon: '🧪',
  },
];

export default function Home() {
  return (
    <div>
      <div className="text-center mb-12">
        <h1 className="text-4xl font-bold text-slate-900 mb-3">
          Pokémon TCG 卡牌遊戲
        </h1>
        <p className="text-slate-500 text-lg max-w-2xl mx-auto">
          歡迎來到 PTCG 卡牌遊戲平台！你可以在這裡瀏覽卡牌、構築牌組，
          並與 AI 進行對戰練習。
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {features.map((feature) => (
          <Link
            key={feature.path}
            to={feature.path}
            className="group bg-home-surface border border-home-border rounded-xl p-6 shadow-sm hover:shadow-lg hover:border-home-accent transition-all duration-200"
          >
            <div className="text-4xl mb-4">{feature.icon}</div>
            <h2 className="text-xl font-semibold text-slate-900 group-hover:text-home-accent mb-2">
              {feature.title}
            </h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              {feature.description}
            </p>
          </Link>
        ))}
      </div>

      <div className="mt-16 bg-home-surface border border-home-border rounded-xl p-8 text-center shadow-sm">
        <h2 className="text-2xl font-bold text-slate-900 mb-3">開始你的冒險</h2>
        <p className="text-slate-500 mb-6">
          選擇上方功能開始遊玩，或先瀏覽卡牌資料庫了解現有卡牌
        </p>
        <Link
          to="/cards"
          className="inline-block bg-home-accent text-white px-8 py-3 rounded-lg font-medium hover:brightness-110 transition-all"
        >
          開始瀏覽卡牌
        </Link>
      </div>
    </div>
  );
}
