import { useState, useEffect } from 'react';
import { collection, doc, addDoc, getDocs, getDoc, updateDoc, deleteDoc, arrayUnion, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { db } from '../config/firebase';
import { showSuccessToast, showErrorToast } from '../utils/toast';
import MatchupCreator from './tournament/MatchupCreator';
import MatchupList from './tournament/MatchupList';
import FourballPairing from './tournament/FourballPairing';
import ExistingFourballsList from './tournament/ExistingFourballsList';
import type { Player } from '../types/player';
import type { Game } from '../types/game';
import type { Tournament, TeamConfig, Matchup } from '../types/tournament';
import { auth } from '../config/firebase';
import { toast } from 'react-hot-toast';
import { track } from '../utils/analytics';
import { calculateAverageTeamHandicaps, type TeamAverageHandicaps } from '../utils/handicapScoring';

interface NewTournamentForm {
  name: string;
  year: number;
  useHandicaps: boolean;
  teamConfig: TeamConfig;
}

export default function TournamentManagement() {
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
  const [selectedUsaPlayer, setSelectedUsaPlayer] = useState('');
  const [selectedEuropePlayer, setSelectedEuropePlayer] = useState('');
  const [currentMatchups, setCurrentMatchups] = useState<Game[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [newTournament, setNewTournament] = useState<NewTournamentForm>({
    name: '',
    year: new Date().getFullYear(),
    useHandicaps: false,
    teamConfig: 'USA_VS_EUROPE'
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(Date.now());
  const [teamAverageHandicaps, setTeamAverageHandicaps] = useState<TeamAverageHandicaps>({ usaAverage: 0, europeAverage: 0 });
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [selectedTournamentToComplete, setSelectedTournamentToComplete] = useState<Tournament | null>(null);
  const [completionYear, setCompletionYear] = useState<number>(new Date().getFullYear());
  const [showScorePreview, setShowScorePreview] = useState(false);
  const [previewPlayerStats, setPreviewPlayerStats] = useState<any[]>([]);
  const [updateHandicaps, setUpdateHandicaps] = useState<boolean>(false);
  const [saveScoresToHistory, setSaveScoresToHistory] = useState<boolean>(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tournamentsSnapshot, playersSnapshot] = await Promise.all([
          getDocs(collection(db, 'tournaments')),
          getDocs(collection(db, 'players'))
        ]);

        const tournamentsData = tournamentsSnapshot.docs.map(doc => {
          const data = doc.data();
          return {
            id: doc.id,
            name: data.name || '',
            year: data.year || new Date().getFullYear(),
            isActive: data.isActive || false,
            useHandicaps: data.useHandicaps || false,
            isComplete: data.isComplete || false,
            teamConfig: data.teamConfig || 'USA_VS_EUROPE',
            totalScore: data.totalScore || {
              raw: { USA: 0, EUROPE: 0 },
              adjusted: { USA: 0, EUROPE: 0 }
            },
            projectedScore: data.projectedScore || {
              raw: { USA: 0, EUROPE: 0 },
              adjusted: { USA: 0, EUROPE: 0 }
            },
            progress: data.progress || [],
            matchups: data.matchups || [],
            createdAt: data.createdAt || new Date().toISOString(),
            updatedAt: data.updatedAt || new Date().toISOString()
          } as Tournament;
        });

        const playersData = playersSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Player[];

        setTournaments(tournamentsData);
        setPlayers(playersData);

        // Set active tournament if exists
        const activeTournament = tournamentsData.find(t => t.isActive);
        if (activeTournament) {
          setSelectedTournament(activeTournament);
          // Fetch matchups for active tournament
          const matchupsSnapshot = await getDocs(
            collection(db, 'tournaments', activeTournament.id, 'games')
          );
          const matchupsData = matchupsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          })) as Game[];
          setCurrentMatchups(matchupsData);
          setLastUpdated(Date.now()); // Update timestamp after data fetch
        }
      } catch (err: any) {
        showErrorToast('Failed to load tournament data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    const checkAdminStatus = async () => {
      if (auth.currentUser) {
        const userDoc = await getDoc(doc(db, 'users', auth.currentUser.uid));
        setIsAdmin(userDoc.exists() && userDoc.data().isAdmin);
      }
    };
    checkAdminStatus();
  }, []);

  useEffect(() => {
    if (!selectedTournament?.id) return; // Ensure selectedTournament and its ID exist

    // Set up real-time listener for games subcollection
    const gamesListenerUnsubscribe = onSnapshot(
      collection(db, 'tournaments', selectedTournament.id, 'games'),
      (snapshot) => {
        const gamesDataFromSubcollection = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Game[];
        
        // Update ONLY currentMatchups (Game[]) with the latest game data from subcollection
        setCurrentMatchups(gamesDataFromSubcollection);
        
        // DO NOT update selectedTournament.matchups here. 
        // selectedTournament.matchups should be sourced from the Tournament document itself,
        // which is handled by fetchData and fetchDataForSelectedTournament.
      },
      (error) => {
        console.error('Error in games subcollection listener:', error);
        toast.error('Failed to get real-time game updates from subcollection');
      }
    );

    // Clean up subscription on unmount or when selectedTournament changes
    return () => {
      gamesListenerUnsubscribe();
    };
  }, [selectedTournament?.id]); // Dependency only on tournament ID

  useEffect(() => {
    if (selectedTournament && selectedTournament.matchups && selectedTournament.matchups.length > 0 && players.length > 0) {
      const playerIdsInMatchups = new Set<string>();
      selectedTournament.matchups.forEach(matchup => {
        // Ensure player IDs are valid strings before adding
        if (matchup.usaPlayerId && typeof matchup.usaPlayerId === 'string') {
          playerIdsInMatchups.add(matchup.usaPlayerId);
        }
        if (matchup.europePlayerId && typeof matchup.europePlayerId === 'string') {
          playerIdsInMatchups.add(matchup.europePlayerId);
        }
      });
  
      const participatingPlayers = players.filter(p => playerIdsInMatchups.has(p.id));
  
      if (participatingPlayers.length > 0) {
        const averages = calculateAverageTeamHandicaps(participatingPlayers);
        setTeamAverageHandicaps(averages);
      } else {
        setTeamAverageHandicaps({ usaAverage: 0, europeAverage: 0 });
      }
    } else {
      setTeamAverageHandicaps({ usaAverage: 0, europeAverage: 0 });
    }
  }, [selectedTournament, players, currentMatchups]); // Added currentMatchups to dependencies

  const handleCreateTournament = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newTournament.name) {
      toast.error('Please enter a tournament name');
      return;
    }

    try {
      setIsLoading(true);

      const tournamentData: Omit<Tournament, 'id'> = {
        name: newTournament.name,
        year: newTournament.year,
        teamConfig: newTournament.teamConfig,
        useHandicaps: newTournament.useHandicaps,
        isComplete: false,
        matchups: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isActive: true,
        handicapStrokes: 0,
        higherHandicapTeam: 'USA',
        totalScore: {
          raw: { USA: 0, EUROPE: 0 },
          adjusted: { USA: 0, EUROPE: 0 }
        },
        projectedScore: {
          raw: { USA: 0, EUROPE: 0 },
          adjusted: { USA: 0, EUROPE: 0 }
        },
        progress: []
      };

      const docRef = await addDoc(collection(db, 'tournaments'), tournamentData);
      
      // Update with server timestamp after creation
      await updateDoc(docRef, { 
        id: docRef.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      // Track tournament creation
      track('tournament_created', {
        tournament_id: docRef.id,
        tournament_name: newTournament.name,
        year: newTournament.year,
        useHandicaps: newTournament.useHandicaps,
        teamConfig: newTournament.teamConfig
      });

      // Reset form
      setNewTournament({
        name: '',
        year: new Date().getFullYear(),
        teamConfig: 'USA_VS_EUROPE',
        useHandicaps: false
      });

      showSuccessToast('Tournament created successfully');
    } catch (err: any) {
      showErrorToast('Failed to create tournament');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateMatchup = async () => {
    if (!selectedTournament || !selectedUsaPlayer || !selectedEuropePlayer) {
      toast.error('Please select both players for the matchup');
      return;
    }

    // Validate that the same player isn't selected for both teams
    if (selectedUsaPlayer === selectedEuropePlayer) {
      toast.error('Cannot select the same player for both teams');
      return;
    }

    setIsLoading(true);
    try {
      let player1Name = '', player2Name = '';
      let player1Id = selectedUsaPlayer, player2Id = selectedEuropePlayer;
      let team1: 'USA' | 'EUROPE' = 'USA';
      let team2: 'USA' | 'EUROPE' = 'EUROPE';
      
      switch (selectedTournament.teamConfig) {
        case 'USA_VS_EUROPE':
          player1Name = availableUsaPlayers.find(p => p.id === selectedUsaPlayer)?.name || '';
          player2Name = availableEuropePlayers.find(p => p.id === selectedEuropePlayer)?.name || '';
          break;
        case 'EUROPE_VS_EUROPE':
          player1Name = availableEuropePlayers.find(p => p.id === selectedUsaPlayer)?.name || '';
          player2Name = availableEuropePlayers.find(p => p.id === selectedEuropePlayer)?.name || '';
          team1 = 'EUROPE';
          team2 = 'EUROPE';
          break;
        case 'USA_VS_USA':
          player1Name = availableUsaPlayers.find(p => p.id === selectedUsaPlayer)?.name || '';
          player2Name = availableUsaPlayers.find(p => p.id === selectedEuropePlayer)?.name || '';
          team1 = 'USA';
          team2 = 'USA';
          break;
      }

      // Calculate handicap strokes if enabled
      let handicapStrokes = 0;
      let higherHandicapTeam: 'USA' | 'EUROPE' = 'USA';
      if (selectedTournament.useHandicaps) {
        handicapStrokes = calculateHandicapDifference(player1Id, player2Id);
        const player1 = availableUsaPlayers.find(p => p.id === player1Id) || availableEuropePlayers.find(p => p.id === player1Id);
        const player2 = availableUsaPlayers.find(p => p.id === player2Id) || availableEuropePlayers.find(p => p.id === player2Id);
        
        if (player1 && player2) {
          higherHandicapTeam = player1.averageScore > player2.averageScore ? team1 : team2;
        }
      }

      // Fetch stroke indices from config
      const strokeIndicesDoc = await getDoc(doc(db, 'config', 'strokeIndices'));
      const strokeIndices = strokeIndicesDoc.data()?.indices || Array(18).fill(0);

      // Create the game document
      const game: Game = {
        id: '', // We'll get this from Firestore
        tournamentId: selectedTournament.id,
        usaPlayerId: player1Id,
        usaPlayerName: player1Name,
        europePlayerId: player2Id,
        europePlayerName: player2Name,
        handicapStrokes,
        higherHandicapTeam,
        holes: Array(18).fill(null).map((_, index) => ({
          holeNumber: index + 1,
          strokeIndex: strokeIndices[index] || 0,
          parScore: 4, // Default par score
          usaPlayerScore: null,
          europePlayerScore: null,
          usaPlayerAdjustedScore: null,
          europePlayerAdjustedScore: null,
          usaPlayerMatchPlayScore: 0,
          europePlayerMatchPlayScore: 0,
          usaPlayerMatchPlayAdjustedScore: 0,
          europePlayerMatchPlayAdjustedScore: 0
        })),
        strokePlayScore: {
          USA: 0,
          EUROPE: 0,
          adjustedUSA: 0,
          adjustedEUROPE: 0
        },
        matchPlayScore: {
          USA: 0,
          EUROPE: 0,
          adjustedUSA: 0,
          adjustedEUROPE: 0
        },
        points: {
          raw: { USA: 0, EUROPE: 0 },
          adjusted: { USA: 0, EUROPE: 0 }
        },
        isComplete: false,
        isStarted: false,
        playerIds: [player1Id, player2Id],
        status: 'not_started'
      };

      // Add the game to the games subcollection
      const gameDocRef = await addDoc(collection(db, 'tournaments', selectedTournament.id, 'games'), game);

      // Update the game with its ID
      const gameWithId = { ...game, id: gameDocRef.id };
      await updateDoc(gameDocRef, { id: gameDocRef.id });

      // Create the matchup object
      const matchup: Matchup = {
        id: gameDocRef.id, // Use the same ID as the game
        usaPlayerId: player1Id,
        europePlayerId: player2Id,
        usaPlayerName: player1Name,
        europePlayerName: player2Name,
        status: 'pending',
        handicapStrokes
      };

      // Update the tournament document with the new matchup
      const tournamentRef = doc(db, 'tournaments', selectedTournament.id);
      await updateDoc(tournamentRef, {
        matchups: arrayUnion(matchup)
      });

      // Track matchup creation
      track('matchup_created', {
        tournament_id: selectedTournament.id,
        game_id: gameDocRef.id,
        usa_player: player1Name,
        europe_player: player2Name,
        usa_player_id: player1Id,
        europe_player_id: player2Id,
        handicap_strokes: handicapStrokes,
        team_config: selectedTournament.teamConfig
      });

      // Update local state with the new game
      setCurrentMatchups(prev => [...prev, gameWithId]);

      // Reset player selection
      setSelectedUsaPlayer('');
      setSelectedEuropePlayer('');

      showSuccessToast('Matchup created successfully');
    } catch (err: any) {
      showErrorToast('Failed to create matchup');
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleActive = async (tournament: Tournament) => {
    try {
      // Add confirmation when deactivating
      if (tournament.isActive) {
        const confirmDeactivate = window.confirm(`Are you sure you want to deactivate "${tournament.name}"?\n\nDeactivating will hide this tournament from players and make it unavailable for gameplay.`);
        if (!confirmDeactivate) {
          return;
        }
      } else {
        // Add confirmation when activating
        const confirmActivate = window.confirm(`Are you sure you want to activate "${tournament.name}"?\n\nThis will make it the active tournament and deactivate any currently active tournament.`);
        if (!confirmActivate) {
          return;
        }
      }
      
      setIsLoading(true);
      
      // If trying to activate a tournament, first deactivate any currently active tournament
      if (!tournament.isActive) {
        const activeTournament = tournaments.find(t => t.isActive);
        if (activeTournament) {
          await updateDoc(doc(db, 'tournaments', activeTournament.id), {
            isActive: false
          });
        }
      }

      // Toggle active state of selected tournament
      await updateDoc(doc(db, 'tournaments', tournament.id), {
        isActive: !tournament.isActive
      });

      // Update local state
      setTournaments(tournaments.map(t => ({
        ...t,
        isActive: t.id === tournament.id ? !t.isActive : false
      })));

      // If activating the tournament, fetch its matchups
      if (!tournament.isActive) {
        // First set the selected tournament
        setSelectedTournament(tournament);
        
        // Then fetch the matchups
        const matchupsSnapshot = await getDocs(
          collection(db, 'tournaments', tournament.id, 'games')
        );
        const matchupsData = matchupsSnapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Game[];
        
        // Update the current matchups
        setCurrentMatchups(matchupsData);
        
        // Update the tournament's matchups array with the fetched games
        const updatedTournament: Tournament = {
          ...tournament,
          matchups: matchupsData.map(game => ({
            id: game.id,
            usaPlayerId: game.usaPlayerId,
            europePlayerId: game.europePlayerId,
            usaPlayerName: game.usaPlayerName,
            europePlayerName: game.europePlayerName,
            status: game.isComplete ? 'completed' as const : game.isStarted ? 'in_progress' as const : 'pending' as const,
            handicapStrokes: game.handicapStrokes
          }))
        };
        
        // Update the selected tournament with the latest matchups
        setSelectedTournament(updatedTournament);
      } else {
        // If deactivating, clear the matchups
        setCurrentMatchups([]);
        setSelectedTournament(null);
      }

      showSuccessToast(`Tournament ${tournament.isActive ? 'deactivated' : 'activated'} successfully`);
    } catch (err: any) {
      showErrorToast('Failed to update tournament status');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteTournament = async (tournament: Tournament) => {
    if (!isAdmin) {
      showErrorToast('You must be an admin to delete tournaments');
      return;
    }

    try {
      setIsLoading(true);

      // Delete all games in the tournament
      const gamesSnapshot = await getDocs(collection(db, 'tournaments', tournament.id, 'games'));
      const deletePromises = gamesSnapshot.docs.map(doc => 
        deleteDoc(doc.ref)
      );
      await Promise.all(deletePromises);

      // Delete the tournament document
      await deleteDoc(doc(db, 'tournaments', tournament.id));

      // Track tournament deletion
      track('tournament_deleted', {
        tournament_id: tournament.id,
        tournament_name: tournament.name,
        year: tournament.year,
        game_count: gamesSnapshot.docs.length
      });

      // Update local state
      setTournaments(tournaments.filter(t => t.id !== tournament.id));
      if (selectedTournament?.id === tournament.id) {
        setSelectedTournament(null);
        setCurrentMatchups([]);
      }

      showSuccessToast('Tournament deleted successfully!');
    } catch (err: any) {
      console.error('Failed to delete tournament:', err);
      showErrorToast('Failed to delete tournament');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteMatchup = async (matchup: Matchup) => {
    if (!selectedTournament) return;

    try {
      setIsLoading(true);

      // Validate that we have both IDs
      if (!matchup.id || !selectedTournament.id) {
        throw new Error('Missing required IDs for deletion');
      }

      // Create the reference to the game document in the games subcollection
      const gamesCollectionRef = collection(db, 'tournaments', selectedTournament.id, 'games');
      const gameDocRef = doc(gamesCollectionRef, matchup.id);

      // Delete the game document
      await deleteDoc(gameDocRef);

      // Track matchup deletion
      track('matchup_deleted', {
        tournament_id: selectedTournament.id,
        tournament_name: selectedTournament.name,
        matchup_id: matchup.id,
        usa_player: matchup.usaPlayerName,
        europe_player: matchup.europePlayerName,
        usa_player_id: matchup.usaPlayerId,
        europe_player_id: matchup.europePlayerId
      });

      // Update the tournament document to remove the matchup
      const tournamentRef = doc(db, 'tournaments', selectedTournament.id);
      const updatedMatchups = selectedTournament.matchups.filter(m => m.id !== matchup.id);

      await updateDoc(tournamentRef, {
        matchups: updatedMatchups
      });

      // Update local state for both tournament and currentMatchups
      setSelectedTournament(prev => prev ? {
        ...prev,
        matchups: updatedMatchups
      } : null);
      setCurrentMatchups(prev => prev.filter(m => m.id !== matchup.id));
      
      // Force a re-render by updating lastUpdated
      setLastUpdated(Date.now());

      toast.success('Matchup deleted successfully');
    } catch (error) {
      console.error('Error deleting matchup:', error);
      toast.error('Failed to delete matchup');
    } finally {
      setIsLoading(false);
    }
  };

  const calculateHandicapDifference = (player1Id: string, player2Id: string): number => {
    const player1 = availableUsaPlayers.find(p => p.id === player1Id) || availableEuropePlayers.find(p => p.id === player1Id);
    const player2 = availableUsaPlayers.find(p => p.id === player2Id) || availableEuropePlayers.find(p => p.id === player2Id);
    
    if (!player1 || !player2) return 0;
    return Math.abs(player1.averageScore - player2.averageScore);
  };

  const handleToggleHandicaps = async (tournament: Tournament) => {
    try {
      const newUseHandicaps = !tournament.useHandicaps;
      
      // Show confirmation dialog
      const message = newUseHandicaps
        ? "Enable handicaps for this tournament? This will adjust scores based on player handicaps."
        : "Disable handicaps for this tournament? This will show raw scores only.";
        
      if (!window.confirm(message)) {
        return;
      }

      const tournamentRef = doc(db, 'tournaments', tournament.id);

      // Update tournament document
      await updateDoc(tournamentRef, {
        useHandicaps: newUseHandicaps,
        updatedAt: new Date().toISOString()
      });

      // Also update with server timestamp
      await updateDoc(tournamentRef, {
        updatedAt: serverTimestamp()
      });

      // Update local state for tournaments
      setTournaments(prev => prev.map(t => 
        t.id === tournament.id 
          ? { ...t, useHandicaps: newUseHandicaps }
          : t
      ));

      // If this is the selected tournament, update it
      if (selectedTournament?.id === tournament.id) {
        setSelectedTournament(prev => prev ? { ...prev, useHandicaps: newUseHandicaps } : null);
      }

      // Force a re-render
      setLastUpdated(Date.now());
      
      setIsLoading(false);
      toast.success(`Handicaps ${newUseHandicaps ? 'enabled' : 'disabled'} successfully`);
    } catch (error) {
      console.error('Error toggling handicaps:', error);
      toast.error('Failed to update handicap settings');
      throw error;
    }
  };

  const handleToggleComplete = async (tournament: Tournament) => {
    try {
      const newIsComplete = !tournament.isComplete;
      
      if (newIsComplete) {
        // Show year selection modal when marking as complete
        setSelectedTournamentToComplete(tournament);
        setCompletionYear(tournament.year || new Date().getFullYear());
        setShowCompletionModal(true);
      } else {
        // Immediately mark as incomplete
        const message = `Mark "${tournament.name}" as incomplete? This will allow making changes to game statuses again.`;
          
        if (!window.confirm(message)) {
          return;
        }

        const tournamentRef = doc(db, 'tournaments', tournament.id);

        // Update tournament document
        await updateDoc(tournamentRef, {
          isComplete: false,
          updatedAt: new Date().toISOString()
        });

        // Also update with server timestamp
        await updateDoc(tournamentRef, {
          updatedAt: serverTimestamp()
        });

        // Update local state for tournaments
        setTournaments(prev => prev.map(t => 
          t.id === tournament.id 
            ? { ...t, isComplete: false }
            : t
        ));

        // If this is the selected tournament, update it
        if (selectedTournament?.id === tournament.id) {
          setSelectedTournament(prev => prev ? { ...prev, isComplete: false } : null);
        }

        // Force a re-render
        setLastUpdated(Date.now());
        
        setIsLoading(false);
        toast.success('Tournament marked as incomplete successfully');
      }
    } catch (error) {
      console.error('Error toggling tournament completion:', error);
      toast.error('Failed to update tournament completion status');
      throw error;
    }
  };

  const handleConfirmTournamentCompletion = async () => {
    if (!selectedTournamentToComplete) return;

    try {
      setIsLoading(true);
      const tournament = selectedTournamentToComplete;

      // Calculate individual player statistics for the year
      const playerStats = new Map();
      
      currentMatchups.filter(game => game.isComplete).forEach(game => {
        // USA Player stats
        if (game.usaPlayerId && game.usaPlayerName) {
          if (!playerStats.has(game.usaPlayerId)) {
            playerStats.set(game.usaPlayerId, {
              playerId: game.usaPlayerId,
              playerName: game.usaPlayerName,
              team: 'USA',
              gamesPlayed: 0,
              totalStrokes: 0,
              totalStrokesAdjusted: 0,
              holesWon: 0,
              holesWonAdjusted: 0,
              pointsEarned: 0,
              pointsEarnedAdjusted: 0
            });
          }
          const stats = playerStats.get(game.usaPlayerId);
          stats.gamesPlayed += 1;
          stats.totalStrokes += game.strokePlayScore?.USA || 0;
          stats.totalStrokesAdjusted += game.strokePlayScore?.adjustedUSA || 0;
          stats.holesWon += game.matchPlayScore?.USA || 0;
          stats.holesWonAdjusted += game.matchPlayScore?.adjustedUSA || 0;
          stats.pointsEarned += game.points?.raw?.USA || 0;
          stats.pointsEarnedAdjusted += game.points?.adjusted?.USA || 0;
        }

        // Europe Player stats
        if (game.europePlayerId && game.europePlayerName) {
          if (!playerStats.has(game.europePlayerId)) {
            playerStats.set(game.europePlayerId, {
              playerId: game.europePlayerId,
              playerName: game.europePlayerName,
              team: 'EUROPE',
              gamesPlayed: 0,
              totalStrokes: 0,
              totalStrokesAdjusted: 0,
              holesWon: 0,
              holesWonAdjusted: 0,
              pointsEarned: 0,
              pointsEarnedAdjusted: 0
            });
          }
          const stats = playerStats.get(game.europePlayerId);
          stats.gamesPlayed += 1;
          stats.totalStrokes += game.strokePlayScore?.EUROPE || 0;
          stats.totalStrokesAdjusted += game.strokePlayScore?.adjustedEUROPE || 0;
          stats.holesWon += game.matchPlayScore?.EUROPE || 0;
          stats.holesWonAdjusted += game.matchPlayScore?.adjustedEUROPE || 0;
          stats.pointsEarned += game.points?.raw?.EUROPE || 0;
          stats.pointsEarnedAdjusted += game.points?.adjusted?.EUROPE || 0;
        }
      });

      // Update player data based on settings
      const playerStatsArray = Array.from(playerStats.values());
      
      if (saveScoresToHistory || updateHandicaps) {
        for (const playerStat of playerStatsArray) {
          const playerDocRef = doc(db, 'players', playerStat.playerId);
          
          // Calculate average scores for this tournament
          const averageScore = playerStat.gamesPlayed > 0 ? 
            Math.round((playerStat.totalStrokes / playerStat.gamesPlayed) * 100) / 100 : 0;
          const averageScoreAdjusted = playerStat.gamesPlayed > 0 ? 
            Math.round((playerStat.totalStrokesAdjusted / playerStat.gamesPlayed) * 100) / 100 : 0;

          // Save historical scores if enabled
          if (saveScoresToHistory) {
            // Create the historical score entry
            const historicalScoreEntry = {
              year: completionYear,
              score: averageScore, // Primary score (raw average)
              scoreAdjusted: averageScoreAdjusted, // Always save adjusted score
              tournamentName: tournament.name,
              tournamentId: tournament.id,
              gamesPlayed: playerStat.gamesPlayed,
              totalStrokes: playerStat.totalStrokes,
              totalStrokesAdjusted: playerStat.totalStrokesAdjusted,
              holesWon: playerStat.holesWon,
              holesWonAdjusted: playerStat.holesWonAdjusted,
              pointsEarned: playerStat.pointsEarned,
              pointsEarnedAdjusted: playerStat.pointsEarnedAdjusted,
              completedAt: new Date().toISOString()
            };

            // Add to player's historicalScores array
            await updateDoc(playerDocRef, {
              historicalScores: arrayUnion(historicalScoreEntry)
            });
          }

          // Recalculate handicap based on last 3 years of scores (only if updateHandicaps is true)
          if (updateHandicaps) {
            // First get the updated player document to access all historical scores
            const updatedPlayerDoc = await getDoc(playerDocRef);
            if (updatedPlayerDoc.exists()) {
              const playerData = updatedPlayerDoc.data();
              const historicalScores = playerData.historicalScores || [];
              
              // Filter scores from the last 3 years (including this completion year)
              const threeYearsAgo = completionYear - 2; // Last 3 years: completionYear-2, completionYear-1, completionYear
              const recentScores = historicalScores.filter((score: any) => 
                score.year >= threeYearsAgo && score.year <= completionYear && score.score != null
              );

              if (recentScores.length > 0) {
                // Calculate average of recent scores for new handicap
                const totalRecentScore = recentScores.reduce((sum: number, score: any) => sum + score.score, 0);
                const newAverageScore = Math.round(totalRecentScore / recentScores.length);
                
                // Update player's averageScore (handicap)
                await updateDoc(playerDocRef, {
                  averageScore: newAverageScore
                });
                
                console.log(`Updated ${playerStat.playerName}'s handicap to ${newAverageScore} (based on ${recentScores.length} scores from ${threeYearsAgo}-${completionYear})`);
              }
            }
          }
        }
      }

      // Mark tournament as complete
      const tournamentRef = doc(db, 'tournaments', tournament.id);
      await updateDoc(tournamentRef, {
        isComplete: true,
        completedYear: completionYear,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      await updateDoc(tournamentRef, {
        updatedAt: serverTimestamp()
      });

      // Update local state
      setTournaments(prev => prev.map(t => 
        t.id === tournament.id 
          ? { ...t, isComplete: true }
          : t
      ));

      if (selectedTournament?.id === tournament.id) {
        setSelectedTournament(prev => prev ? { ...prev, isComplete: true } : null);
      }

      // Close modal and reset state
      setShowCompletionModal(false);
      setShowScorePreview(false);
      setSelectedTournamentToComplete(null);
      setUpdateHandicaps(false);
      setSaveScoresToHistory(false);
      setLastUpdated(Date.now());
      
      let message = 'Tournament marked as complete!';
      if (saveScoresToHistory && updateHandicaps) {
        message = `Tournament completed! Player scores added to ${completionYear} historical records and handicaps updated.`;
      } else if (saveScoresToHistory) {
        message = `Tournament completed! Player scores added to ${completionYear} historical records. Handicaps were not updated.`;
      } else if (updateHandicaps) {
        message = `Tournament completed! Handicaps updated. No historical scores were saved.`;
      } else {
        message = 'Tournament marked as complete! No player data was modified.';
      }
      toast.success(message);
    } catch (error) {
      console.error('Error completing tournament:', error);
      toast.error('Failed to complete tournament');
    } finally {
      setIsLoading(false);
    }
  };

  const handleShowScorePreview = async () => {
    setIsLoading(true);
    try {
      // Calculate player stats for preview
      const playerStats = new Map();
      
      currentMatchups.filter(game => game.isComplete).forEach(game => {
        // USA Player stats
        if (game.usaPlayerId && game.usaPlayerName) {
          if (!playerStats.has(game.usaPlayerId)) {
            playerStats.set(game.usaPlayerId, {
              playerId: game.usaPlayerId,
              playerName: game.usaPlayerName,
              team: 'USA',
              gamesPlayed: 0,
              totalStrokes: 0,
              totalStrokesAdjusted: 0,
              currentHandicap: 0,
              newHandicap: 0,
              historicalScoresUsed: []
            });
          }
          const stats = playerStats.get(game.usaPlayerId);
          stats.gamesPlayed += 1;
          stats.totalStrokes += game.strokePlayScore?.USA || 0;
          stats.totalStrokesAdjusted += game.strokePlayScore?.adjustedUSA || 0;
        }

        // Europe Player stats
        if (game.europePlayerId && game.europePlayerName) {
          if (!playerStats.has(game.europePlayerId)) {
            playerStats.set(game.europePlayerId, {
              playerId: game.europePlayerId,
              playerName: game.europePlayerName,
              team: 'EUROPE',
              gamesPlayed: 0,
              totalStrokes: 0,
              totalStrokesAdjusted: 0,
              currentHandicap: 0,
              newHandicap: 0,
              historicalScoresUsed: []
            });
          }
          const stats = playerStats.get(game.europePlayerId);
          stats.gamesPlayed += 1;
          stats.totalStrokes += game.strokePlayScore?.EUROPE || 0;
          stats.totalStrokesAdjusted += game.strokePlayScore?.adjustedEUROPE || 0;
        }
      });

      // Fetch current player data and calculate new handicaps
      const playerStatsArray = Array.from(playerStats.values());
      
      for (const playerStat of playerStatsArray) {
        try {
          // Get current player data
          const playerDoc = await getDoc(doc(db, 'players', playerStat.playerId));
          if (playerDoc.exists()) {
            const playerData = playerDoc.data();
            
            playerStat.currentHandicap = Math.round(playerData.averageScore || 0);
            
            // Calculate this tournament's average score
            const tournamentAverageScore = playerStat.gamesPlayed > 0 ? 
              Math.round((playerStat.totalStrokes / playerStat.gamesPlayed) * 100) / 100 : 0;
            
            // Simulate the new handicap calculation
            const historicalScores = playerData.historicalScores || [];
            
            // Create the simulated new score entry
            const newScoreEntry = {
              year: completionYear,
              score: tournamentAverageScore
            };
            
            // Combine existing scores with the new one
            const allScores = [...historicalScores, newScoreEntry];
            
            // Filter scores from the last 3 years (including completion year)
            const threeYearsAgo = completionYear - 2;
            const recentScores = allScores.filter((score: any) => 
              score.year >= threeYearsAgo && score.year <= completionYear && score.score != null
            );

            // Store the historical scores being used for display
            playerStat.historicalScoresUsed = recentScores.sort((a: any, b: any) => b.year - a.year);

            if (recentScores.length > 0) {
              const totalRecentScore = recentScores.reduce((sum: number, score: any) => sum + score.score, 0);
              playerStat.newHandicap = Math.round(totalRecentScore / recentScores.length);
            } else {
              playerStat.newHandicap = Math.round(tournamentAverageScore);
            }
          } else {
            playerStat.currentHandicap = 0;
            playerStat.newHandicap = 0;
            playerStat.historicalScoresUsed = [];
          }
        } catch (error) {
          console.error(`Error fetching data for player ${playerStat.playerName}:`, error);
          playerStat.currentHandicap = 0;
          playerStat.newHandicap = 0;
          playerStat.historicalScoresUsed = [];
        }
      }

      setPreviewPlayerStats(playerStatsArray);
      setShowScorePreview(true);
    } catch (error) {
      console.error('Error calculating preview data:', error);
      toast.error('Failed to calculate preview data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToYearSelection = () => {
    setShowScorePreview(false);
  };

  // Function to explicitly refetch data for the selected tournament
  const fetchDataForSelectedTournament = async (tournamentId: string) => {
    setIsLoading(true);
    try {
      const tournamentDocRef = doc(db, 'tournaments', tournamentId);
      const tournamentSnap = await getDoc(tournamentDocRef);

      if (tournamentSnap.exists()) {
        const tournamentData = tournamentSnap.data();
        const updatedTournamentObject = {
          id: tournamentSnap.id,
          name: tournamentData.name || '',
          year: tournamentData.year || new Date().getFullYear(),
          isActive: tournamentData.isActive || false,
          useHandicaps: tournamentData.useHandicaps || false,
          isComplete: tournamentData.isComplete || false,
          teamConfig: tournamentData.teamConfig || 'USA_VS_EUROPE',
          totalScore: tournamentData.totalScore || { raw: { USA: 0, EUROPE: 0 }, adjusted: { USA: 0, EUROPE: 0 } },
          projectedScore: tournamentData.projectedScore || { raw: { USA: 0, EUROPE: 0 }, adjusted: { USA: 0, EUROPE: 0 } },
          progress: tournamentData.progress || [],
          matchups: tournamentData.matchups || [], // This is the key array to update
          createdAt: tournamentData.createdAt?.toDate ? tournamentData.createdAt.toDate().toISOString() : new Date().toISOString(),
          updatedAt: tournamentData.updatedAt?.toDate ? tournamentData.updatedAt.toDate().toISOString() : new Date().toISOString(),
        } as Tournament;
        setSelectedTournament(updatedTournamentObject);

        // Also refetch games for consistency, though matchups array on Tournament doc is the source of truth for pairings
        const gamesSnapshot = await getDocs(
          collection(db, 'tournaments', tournamentId, 'games')
        );
        const gamesData = gamesSnapshot.docs.map(gDoc => ({
          id: gDoc.id,
          ...gDoc.data()
        })) as Game[];
        setCurrentMatchups(gamesData);
        
        // Update the main tournaments list as well if this tournament was updated
        setTournaments(prevTournaments => prevTournaments.map(t => t.id === tournamentId ? updatedTournamentObject : t));

      } else {
        showErrorToast(`Tournament ${tournamentId} not found while refetching.`);
        setSelectedTournament(null);
      }
    } catch (error) {
      console.error("Error refetching selected tournament data:", error);
      showErrorToast('Failed to refresh tournament data.');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
      </div>
    );
  }

  // Filter out players already in matchups
  const availableUsaPlayers = (selectedTournament?.teamConfig === 'USA_VS_EUROPE' || selectedTournament?.teamConfig === 'USA_VS_USA')
    ? players
        .filter(p => p.team === 'USA')
        .filter(p => !currentMatchups.some(m => m.usaPlayerId === p.id || m.europePlayerId === p.id))
    : [];

  const availableEuropePlayers = selectedTournament?.teamConfig === 'EUROPE_VS_EUROPE'
    ? players
        .filter(p => p.team === 'EUROPE')
        .filter(p => !currentMatchups.some(m => m.usaPlayerId === p.id || m.europePlayerId === p.id))
    : selectedTournament?.teamConfig === 'USA_VS_EUROPE'
      ? players
          .filter(p => p.team === 'EUROPE')
          .filter(p => !currentMatchups.some(m => m.europePlayerId === p.id))
      : [];

  return (
    <div className="space-y-6" key={lastUpdated}>
      {/* Tournament Selection/Creation */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold dark:text-white">Tournament Setup</h2>
          {isAdmin && (
            <button
              onClick={() => setShowCreateForm(prev => !prev)}
              className="bg-gradient-to-br from-europe-500 to-europe-600 text-white px-4 py-2 rounded-lg shadow-sm hover:shadow transition-all duration-200 w-full sm:w-auto"
            >
              {showCreateForm ? 'Cancel' : 'Create New Tournament'}
            </button>
          )}
        </div>

        {isAdmin && showCreateForm && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Name
                </label>
                <input
                  type="text"
                  value={newTournament.name}
                  onChange={(e) => setNewTournament({ ...newTournament, name: e.target.value })}
                  className="w-full px-4 py-2 rounded-lg border dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  placeholder="Enter tournament name"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Year
                  </label>
                  <input
                    type="number"
                    value={newTournament.year}
                    onChange={(e) => setNewTournament({ ...newTournament, year: Number(e.target.value) })}
                    className="w-full px-4 py-2 rounded-lg border dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Team Configuration
                  </label>
                  <select
                    value={newTournament.teamConfig}
                    onChange={(e) => setNewTournament({ ...newTournament, teamConfig: e.target.value as TeamConfig })}
                    className="w-full px-4 py-2 rounded-lg border dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  >
                    <option value="USA_VS_EUROPE">USA vs Europe</option>
                    <option value="EUROPE_VS_EUROPE">Europe vs Europe</option>
                    <option value="USA_VS_USA">USA vs USA</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="useHandicaps"
                  checked={newTournament.useHandicaps}
                  onChange={(e) => setNewTournament({ ...newTournament, useHandicaps: e.target.checked })}
                  className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded"
                />
                <label htmlFor="useHandicaps" className="ml-2 block text-sm text-gray-900 dark:text-gray-300">
                  Use Handicaps
                </label>
              </div>
              <button
                onClick={handleCreateTournament}
                disabled={isLoading}
                className="w-full bg-gradient-to-br from-purple-500 to-purple-600 text-white py-2 px-4 rounded-lg shadow-sm hover:shadow transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Tournament
              </button>
            </div>
          </div>
        )}

        <div className="grid gap-4 grid-cols-1">
          {tournaments.map((tournament) => (
            <div
              key={tournament.id}
              className={`p-4 rounded-lg transition-all duration-300 ${
                tournament.isActive
                  ? 'border-2 border-purple-500 bg-gray-50 dark:bg-gray-700 shadow-md'
                  : 'bg-white dark:bg-gray-800 shadow-sm hover:shadow'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                <div className="flex-1">
                  <div className="flex justify-between items-start">
                    <h3 className="text-lg font-medium dark:text-white">
                      {tournament.name}
                    </h3>
                    {isAdmin && (
                      <div className="relative group ml-auto sm:ml-0">
                        <button
                          onClick={() => {
                            const firstConfirm = window.confirm(`Are you sure you want to delete the tournament "${tournament.name}"?`);
                            if (firstConfirm) {
                              const secondConfirm = window.confirm(`⚠️ FINAL WARNING: This will permanently delete all games and data for "${tournament.name}". This action cannot be undone.`);
                              if (secondConfirm) {
                                handleDeleteTournament(tournament);
                              }
                            }
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors duration-150"
                          aria-label="Delete tournament"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
                          </svg>
                          <span className="sr-only sm:not-sr-only">Delete</span>
                        </button>
                        <div className="absolute hidden group-hover:block w-48 p-2 bg-gray-800 text-xs text-gray-300 rounded shadow-lg z-10 -bottom-12 right-0">
                          Double confirmation required
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Year:</span>
                      <span className="font-medium">{tournament.year}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Status:</span>
                      <span className={`font-medium ${tournament.isActive ? 'text-green-600 dark:text-green-500' : 'text-gray-600 dark:text-gray-400'}`}>
                        {tournament.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Completion:</span>
                      <span className={`font-medium ${tournament.isComplete ? 'text-emerald-600 dark:text-emerald-500' : 'text-orange-600 dark:text-orange-400'}`}>
                        {tournament.isComplete ? 'Complete' : 'In Progress'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-gray-500">Team Config:</span>
                      <span className="font-medium">{tournament.teamConfig.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-3 sm:mt-0">
                  {tournament.isActive && (
                    <>
                      <div className="flex items-center gap-3 p-2 bg-gray-100 dark:bg-gray-600 rounded-lg">
                        <button
                          onClick={() => handleToggleHandicaps(tournament)}
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 ${
                            tournament.useHandicaps ? 'bg-purple-600' : 'bg-gray-300 dark:bg-gray-500'
                          }`}
                          role="switch"
                          aria-checked={tournament.useHandicaps}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              tournament.useHandicaps ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Handicaps
                          </span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {tournament.useHandicaps ? 'Adjusted scores' : 'Raw scores'}
                          </span>
                        </div>
                      </div>
                      {isAdmin && (
                        <div className="flex items-center gap-3 p-2 bg-gray-100 dark:bg-gray-600 rounded-lg">
                          <button
                            onClick={() => handleToggleComplete(tournament)}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${
                              tournament.isComplete ? 'bg-emerald-600' : 'bg-gray-300 dark:bg-gray-500'
                            }`}
                            role="switch"
                            aria-checked={tournament.isComplete}
                          >
                            <span
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                tournament.isComplete ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </button>
                          <div className="flex flex-col">
                            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                              Complete
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {tournament.isComplete ? 'Locked' : 'Editable'}
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => handleToggleActive(tournament)}
                    className={`px-4 py-2 rounded-lg transition-colors shadow-sm hover:shadow ${
                      tournament.isActive
                        ? 'bg-purple-600 hover:bg-purple-700 text-white'
                        : 'bg-gradient-to-br from-purple-500 to-purple-600 text-white'
                    } text-sm whitespace-nowrap flex-1 sm:flex-auto text-center`}
                  >
                    {tournament.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {selectedTournament && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <MatchupCreator
            availableUsaPlayers={availableUsaPlayers}
            availableEuropePlayers={availableEuropePlayers}
            selectedUsaPlayer={selectedUsaPlayer}
            selectedEuropePlayer={selectedEuropePlayer}
            onUsaPlayerSelect={setSelectedUsaPlayer}
            onEuropePlayerSelect={setSelectedEuropePlayer}
            onCreateMatchup={handleCreateMatchup}
            isLoading={isLoading}
            teamConfig={selectedTournament.teamConfig}
          />
          <MatchupList
            key={`matchup-list-${selectedTournament.id}`}
            matchups={selectedTournament.matchups}
            currentMatchups={currentMatchups}
            teamConfig={selectedTournament.teamConfig}
            onDeleteMatchup={handleDeleteMatchup}
            isAdmin={true}
            useHandicaps={selectedTournament.useHandicaps}
            teamAverageHandicaps={teamAverageHandicaps}
          />
        </div>
      )}

      {/* Fourball Pairing Section */}
      {isAdmin && selectedTournament && (
        <FourballPairing 
          tournamentId={selectedTournament.id}
          allMatchups={selectedTournament.matchups || []}
          onPairingComplete={() => fetchDataForSelectedTournament(selectedTournament.id)}
        />
      )}

      {/* Existing Fourballs List Section - Added */}
      {isAdmin && selectedTournament && (
        <ExistingFourballsList
          tournamentId={selectedTournament.id}
          allMatchups={selectedTournament.matchups || []}
          onUnpairComplete={() => fetchDataForSelectedTournament(selectedTournament.id)}
        />
      )}

      {showCompletionModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            {!showScorePreview ? (
              // Year Selection Step
              <>
                <h2 className="text-xl font-semibold mb-4 dark:text-white">Complete Tournament</h2>
                <p className="text-gray-700 dark:text-gray-300 mb-4">
                  Mark "{selectedTournamentToComplete?.name}" as complete and save scores for the selected year.
                </p>
                
                <div className="mb-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Save scores for year:
                    </label>
                    <select
                      value={completionYear}
                      onChange={(e) => setCompletionYear(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      {/* Generate year options from current year - 5 to current year + 5 */}
                      {Array.from({ length: 11 }, (_, i) => {
                        const year = new Date().getFullYear() - 5 + i;
                        return (
                          <option key={year} value={year}>
                            {year}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-start">
                      <input
                        type="checkbox"
                        id="saveScoresToHistory"
                        checked={saveScoresToHistory}
                        onChange={(e) => {
                          setSaveScoresToHistory(e.target.checked);
                          if (!e.target.checked) {
                            setUpdateHandicaps(false);
                          }
                        }}
                        className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded mt-1"
                      />
                      <div className="ml-3">
                        <label htmlFor="saveScoresToHistory" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Save scores to historical records
                        </label>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          When checked, tournament scores will be saved to player historical records for year {completionYear}.
                          Uncheck to complete tournament without saving historical data.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start">
                      <input
                        type="checkbox"
                        id="updateHandicaps"
                        checked={updateHandicaps}
                        onChange={(e) => setUpdateHandicaps(e.target.checked)}
                        disabled={!saveScoresToHistory}
                        className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded mt-1 disabled:opacity-50"
                      />
                      <div className="ml-3">
                        <label htmlFor="updateHandicaps" className={`text-sm font-medium ${saveScoresToHistory ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>
                          Update player handicaps
                        </label>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          {saveScoresToHistory 
                            ? 'When checked, player handicaps will be recalculated based on their scores from the last 3 years.'
                            : 'Requires "Save scores to historical records" to be enabled first.'
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => {
                      setShowCompletionModal(false);
                      setSelectedTournamentToComplete(null);
                      setShowScorePreview(false);
                      setUpdateHandicaps(false);
                      setSaveScoresToHistory(false);
                    }}
                    className="px-4 py-2 text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-500 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleShowScorePreview}
                    className="px-4 py-2 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-lg hover:shadow transition-all duration-200"
                  >
                    Preview Scores
                  </button>
                </div>
              </>
            ) : (
              // Score Preview Step
              <>
                <h2 className="text-xl font-semibold mb-4 dark:text-white">Player Scores Preview</h2>
                <p className="text-gray-700 dark:text-gray-300 mb-4">
                  These player scores will be saved to year <strong>{completionYear}</strong> records:
                </p>

                {selectedTournamentToComplete && (
                  <div className="space-y-4 mb-6">
                    {/* Tournament Summary */}
                    <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                      <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Tournament Summary for {completionYear}</h3>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">Games Completed:</span>
                          <span className="ml-2 font-medium">{currentMatchups.filter(game => game.isComplete).length}</span>
                        </div>
                        <div>
                          <span className="text-gray-600 dark:text-gray-400">Total Games:</span>
                          <span className="ml-2 font-medium">{currentMatchups.length}</span>
                        </div>
                      </div>
                    </div>

                    {/* Player Statistics Preview */}
                    <div className="bg-gray-50 dark:bg-gray-700 p-4 rounded-lg">
                      <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Historical Scores to be Added</h3>
                      <div className="space-y-3 max-h-60 overflow-y-auto">
                        {previewPlayerStats.map((player) => {
                          const averageScore = player.gamesPlayed > 0 ? 
                            Math.round((player.totalStrokes / player.gamesPlayed) * 100) / 100 : 0;
                          const averageScoreAdjusted = player.gamesPlayed > 0 ? 
                            Math.round((player.totalStrokesAdjusted / player.gamesPlayed) * 100) / 100 : 0;
                          
                          return (
                            <div key={player.playerId} className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden">
                              {/* Header */}
                              <div className="bg-gray-50 dark:bg-gray-700 px-4 py-3 border-b border-gray-200 dark:border-gray-600">
                                <div className="flex justify-between items-center">
                                  <h4 className="font-semibold text-gray-900 dark:text-white">{player.playerName}</h4>
                                  <span className={`px-2.5 py-1 text-xs font-medium rounded-full ${
                                    player.team === 'USA' 
                                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' 
                                      : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                  }`}>
                                    {player.team}
                                  </span>
                                </div>
                              </div>
                              
                              {/* Main Content */}
                              <div className="p-4 space-y-4">
                                {/* Tournament Score - Primary */}
                                <div className="text-center">
                                  <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Tournament Score</div>
                                  <div className="text-3xl font-bold text-gray-900 dark:text-white">{averageScore}</div>
                                  {averageScore !== averageScoreAdjusted && (
                                    <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                                      Adjusted: {averageScoreAdjusted}
                                    </div>
                                  )}
                                </div>
                                
                                {/* Handicap Section */}
                                {updateHandicaps ? (
                                  <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
                                    <div className="flex items-center justify-center gap-3 mb-2">
                                      <span className="text-lg font-medium text-gray-900 dark:text-white">{player.currentHandicap}</span>
                                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                      </svg>
                                      <span className={`text-lg font-bold ${
                                        player.newHandicap < player.currentHandicap 
                                          ? 'text-green-600 dark:text-green-400' 
                                          : player.newHandicap > player.currentHandicap 
                                            ? 'text-red-600 dark:text-red-400' 
                                            : 'text-gray-900 dark:text-white'
                                      }`}>
                                        {player.newHandicap}
                                      </span>
                                      {player.newHandicap !== player.currentHandicap && (
                                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                                          player.newHandicap < player.currentHandicap 
                                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' 
                                            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                                        }`}>
                                          {player.newHandicap < player.currentHandicap ? 'Improved' : 'Higher'}
                                        </span>
                                      )}
                                    </div>
                                    
                                    <div className="text-center text-xs text-gray-600 dark:text-gray-400 mb-2">
                                      Handicap Update
                                    </div>
                                    
                                    {/* Historical Scores Used */}
                                    {player.historicalScoresUsed && player.historicalScoresUsed.length > 0 && (
                                      <div className="pt-2 border-t border-amber-200 dark:border-amber-700">
                                        <div className="text-xs text-gray-500 dark:text-gray-400 text-center mb-2">
                                          Based on scores from {completionYear - 2}-{completionYear}
                                        </div>
                                        <div className="flex flex-wrap gap-1 justify-center">
                                          {player.historicalScoresUsed.map((score: any, index: number) => (
                                            <span 
                                              key={`${score.year}-${index}`}
                                              className={`text-xs px-2 py-1 rounded ${
                                                score.year === completionYear 
                                                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium' 
                                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                                              }`}
                                            >
                                              {score.year}: {Math.round(score.score * 100) / 100}
                                              {score.year === completionYear && ' (new)'}
                                            </span>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 text-center">
                                    <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Current Handicap</div>
                                    <div className="text-lg font-medium text-gray-900 dark:text-white">{player.currentHandicap}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">(will not be updated)</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Note about data saving */}
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-3 rounded-lg">
                      <p className="text-sm text-blue-800 dark:text-blue-200">
                        <strong>Tournament Completion Actions:</strong>
                        <span className="block mt-1">
                          {saveScoresToHistory ? (
                            <span>✓ Player scores will be saved to year {completionYear} records.</span>
                          ) : (
                            <span>⚠️ Player scores will NOT be saved to historical records.</span>
                          )}
                        </span>
                        <span className="block mt-1">
                          {updateHandicaps ? (
                            <span>✓ Player handicaps will be updated based on recent scores.</span>
                          ) : (
                            <span>⚠️ Player handicaps will NOT be updated.</span>
                          )}
                        </span>
                        {!saveScoresToHistory && !updateHandicaps && (
                          <span className="block mt-2 font-medium">
                            🔒 Tournament will only be marked as complete - no data changes.
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex justify-end space-x-3">
                  <button
                    onClick={handleBackToYearSelection}
                    className="px-4 py-2 text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-600 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-500 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleConfirmTournamentCompletion}
                    disabled={isLoading}
                    className="px-4 py-2 bg-gradient-to-br from-purple-500 to-purple-600 text-white rounded-lg hover:shadow transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? 'Saving...' : 'Save & Complete Tournament'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}