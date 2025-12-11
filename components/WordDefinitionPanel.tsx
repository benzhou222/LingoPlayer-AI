import React, { useState } from 'react';
import { WordDefinition } from '../types';
import { Volume2, Plus, Check, Search } from 'lucide-react';
import { playAudio } from '../services/geminiService';

interface WordDefinitionPanelProps {
  definition: WordDefinition | null;
  onAddToVocab: (word: WordDefinition) => void;
  isSaved: boolean;
  isLoading: boolean;
  onWordSearch: (word: string) => void;
}

export const WordDefinitionPanel: React.FC<WordDefinitionPanelProps> = ({ 
  definition, 
  onAddToVocab, 
  isSaved,
  isLoading,
  onWordSearch
}) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSpeak = async () => {
    if (!definition) return;
    setIsSpeaking(true);
    // In offline mode, we pass the word directly to the modified 'playAudio' which uses speechSyntehsis
    await playAudio(definition.word);
    
    // Reset icon after a short delay since we don't have an "onend" event easily piped through
    setTimeout(() => setIsSpeaking(false), 1000);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      onWordSearch(searchQuery.trim());
      setSearchQuery('');
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="h-full flex items-center justify-center text-gray-500">
          <div className="flex flex-col items-center gap-2">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-sm">Consulting Dictionary...</span>
          </div>
        </div>
      );
    }

    if (!definition) {
      return (
        <div className="h-full flex items-center justify-center text-gray-500 p-6 text-center">
          <span className="italic">Click any word in the subtitle or use the search bar below to see a definition.</span>
        </div>
      );
    }

    return (
      <div className="p-6 flex flex-col md:flex-row gap-6">
        {/* Header Info */}
        <div className="flex-shrink-0 min-w-[200px]">
          <div className="flex items-baseline gap-3 mb-2">
            <h2 className="text-3xl font-bold text-white tracking-wide">{definition.word}</h2>
            <span className="text-sm text-gray-400 italic px-2 py-0.5 bg-gray-800 rounded">{definition.partOfSpeech}</span>
          </div>
          
          <div className="flex items-center gap-3 mb-4">
            <button 
              onClick={handleSpeak}
              disabled={isSpeaking}
              className={`flex items-center gap-2 px-3 py-1 rounded-full text-sm font-mono border transition-colors ${isSpeaking ? 'bg-blue-900/30 border-blue-500/50 text-blue-300' : 'bg-gray-800 border-gray-700 text-cyan-400 hover:bg-gray-700 hover:border-gray-600'}`}
            >
              <Volume2 size={16} />
              <span>/{definition.phonetic}/</span>
            </button>
          </div>

          <button
            onClick={() => onAddToVocab(definition)}
            disabled={isSaved}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all w-full justify-center ${
              isSaved 
                ? 'bg-green-900/30 text-green-400 cursor-default'
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'
            }`}
          >
            {isSaved ? <><Check size={18} /> Saved</> : <><Plus size={18} /> Add to Vocabulary</>}
          </button>
        </div>

        {/* Details */}
        <div className="flex-grow border-l border-gray-800 pl-6 space-y-3">
          <div>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-1">Meaning</h3>
            <p className="text-lg text-gray-200 leading-relaxed">{definition.meaning}</p>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-1">Context Usage</h3>
              <p className="text-sm text-gray-300 italic">"{definition.usage}"</p>
            </div>
            <div>
              <h3 className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-1">Example</h3>
              <p className="text-sm text-gray-300">"{definition.example}"</p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-gray-900 border-t border-gray-800">
      <div className="flex-1 overflow-y-auto min-h-[150px]">
        {renderContent()}
      </div>
      
      {/* Search Bar Footer */}
      <div className="p-4 bg-gray-900/50 flex-shrink-0">
        <form onSubmit={handleSearch} className="relative group w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within:text-blue-400 transition-colors" size={14} />
            <input 
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search dictionary..."
              className="w-full bg-gray-950 border border-gray-800 text-gray-300 text-xs rounded-lg py-2 pl-9 pr-4 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 transition-all placeholder-gray-600"
            />
        </form>
      </div>
    </div>
  );
};