import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">TradingApp</h1>
        <p className="text-lg text-gray-700 mb-8">
          Welcome to your web-based trading platform
        </p>
        <Link 
          href="/settings" 
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Go to Settings
        </Link>
      </div>
    </main>
  )
} 