'use client';
import React, { useEffect, useState } from 'react';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://10.7.3.20:4000/api/settings')
      .then(res => res.json())
      .then(data => {
        setSettings(data);
        setLoading(false);
      });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">Application Settings</h1>
      <div className="space-y-4 max-w-xl">
        {Object.entries(settings).map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <label className="font-semibold">{key}</label>
            <input
              className="border p-2 rounded"
              value={value}
              readOnly
              type={key.toLowerCase().includes('password') ? 'password' : 'text'}
            />
          </div>
        ))}
      </div>
    </main>
  );
} 