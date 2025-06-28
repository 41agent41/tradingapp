'use client';
import React, { useEffect, useState } from 'react';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // For remote server deployment, use the server's IP address
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://10.7.3.20:4000';
    
    console.log('Attempting to fetch settings from:', apiUrl);
    
    fetch(`${apiUrl}/api/settings`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        console.log('Settings loaded successfully:', data);
        setSettings(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching settings:', err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Application Settings</h1>
      <div className="text-blue-600">Loading settings...</div>
    </div>
  );
  
  if (error) return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Application Settings</h1>
      <div className="text-red-600">Error loading settings: {error}</div>
      <div className="mt-4 text-sm text-gray-600">
        Please check that the backend service is running on port 4000.
      </div>
    </div>
  );

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-4">Application Settings</h1>
      <div className="space-y-4 max-w-xl">
        {Object.entries(settings).length === 0 ? (
          <div className="text-gray-600">No settings found</div>
        ) : (
          Object.entries(settings).map(([key, value]) => (
            <div key={key} className="flex flex-col">
              <label className="font-semibold">{key}</label>
              <input
                className="border p-2 rounded"
                value={value}
                readOnly
                type={key.toLowerCase().includes('password') ? 'password' : 'text'}
              />
            </div>
          ))
        )}
      </div>
    </main>
  );
} 