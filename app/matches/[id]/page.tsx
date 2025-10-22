"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  Implementation,
  createDelegation,
  toMetaMaskSmartAccount,
} from "@metamask/delegation-toolkit";
import { type Hex, parseEther } from "viem";
import { MatchTradingView } from "@/components/matches/match-trading-view";
import { MonachadProfileModal } from "@/components/matches/monachad-profile-modal";
import { ChartViewOnly } from "@/components/matches/chart-view-only";
import { BattleFeedPanel } from "@/components/matches/battle-feed-panel";
import { useMatchEvents } from "@/hooks/use-match-events";
import { safeFormatEther } from "@/utils/format";
import { getMatchStatusDisplay } from "@/utils/display";
import { match } from "assert/strict";

type ParticipantRole = "MONACHAD" | "SUPPORTER";

interface Participant {
  address: string;
  role: ParticipantRole;
  marginAmount?: string;
  entryFeePaid?: string;
  fundedAmount?: string;
  stakedAmount?: string; // legacy fallback
  pnl?: string;
  joinedAt?: string;
  followingAddress?: string | null;
}

interface MatchRecord {
  matchId: string;
  status: string;
  entryMargin: string;
  prizePool: string;
  duration: number;
  maxParticipants: number;
  maxSupporters?: number | null;
  allowedDexes?: string[];
  creator?: string;
  startTime?: string;
  endTime?: string;
  winner?: string | null;
  // participants?: Participant[];
  topMonachads: Participant[];
  monachadCount: number;
  topSupporters: Participant[];
  supporterCount: number;
  participantCount: number;
}

interface DexMeta {
  name: string;
  address: string;
  logo: string;
  description: string;
}

const calculateRoi = (pnl?: string, basis?: string) => {
  try {
    const pnlEth = Number(safeFormatEther(pnl ?? "0"));
    const basisEth = Number(safeFormatEther(basis ?? "0"));
    if (!Number.isFinite(basisEth) || basisEth === 0) {
      return "0.0";
    }

    const roi = (pnlEth / basisEth) * 100;
    return roi.toFixed(1);
  } catch {
    return "0.0";
  }
};

const getParticipantStakeWei = (participant?: Participant | null) => {
  if (participant?.role === "MONACHAD") {
    return participant?.marginAmount ?? "0";
  }
  return participant?.fundedAmount ?? "0";
};

const mockChartData = Array.from({ length: 12 }).map((_, index) => ({
  label: `Round ${index + 1}`,
  value: Math.round(50 + Math.random() * 50),
}));

export default function MatchDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const matchId = params?.id ?? "";

  const { address, isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // Contract addresses
  const fundexAddress = "0x16b0c1DCF87EBB4e0A0Ba4514FF0782CCE7889Cb";
  const matchManagerAddress =
    process.env.NEXT_PUBLIC_MATCH_MANAGER_ADDRESS ||
    "0x0000000000000000000000000000000000000000";

  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isStartingMatch, setIsStartingMatch] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [joinMode, setJoinMode] = useState<"monachad" | "supporter" | null>(
    null
  );
  const [customMargin, setCustomMargin] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [selectedMonachad, setSelectedMonachad] = useState<string | null>(null);
  const [userParticipant, setUserParticipant] = useState<Participant | null>(
    null
  );

  // Monachad profile modal
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [selectedProfileAddress, setSelectedProfileAddress] = useState<
    string | null
  >(null);

  const openMonachadProfile = (address: string) => {
    setSelectedProfileAddress(address);
    setProfileModalOpen(true);
  };

  const closeMonachadProfile = () => {
    setProfileModalOpen(false);
    setSelectedProfileAddress(null);
  };

  const fetchMatchDetails = useCallback(async () => {
    if (!matchId) {
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!baseUrl) {
      setLoadError("NEXT_PUBLIC_API_URL is not configured");
      setLoading(false);
      return;
    }

    try {
      setLoadError(null);
      if (!loading) {
        setIsRefreshing(true);
      }

      const response = await fetch(`${baseUrl}/matches/${matchId}`);
      if (!response.ok) {
        throw new Error(`Failed to load match ${matchId}`);
      }

      const data: MatchRecord = await response.json();
      setMatch(data);
    } catch (error: any) {
      console.error("Failed to fetch match", error);
      setLoadError(error?.message ?? "Unable to load match");
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [matchId, loading]);

  useEffect(() => {
    fetchMatchDetails();
  }, [fetchMatchDetails]);

  useEffect(() => {
    if (match?.status !== "ACTIVE") {
      return;
    }

    const interval = setInterval(fetchMatchDetails, 15000);
    return () => clearInterval(interval);
  }, [match?.status, fetchMatchDetails]);

  useEffect(() => {
    if (joinMode !== "monachad" || !match?.entryMargin) {
      return;
    }

    if (!customMargin) {
      setCustomMargin(safeFormatEther(match.entryMargin));
    }
  }, [joinMode, match?.entryMargin, customMargin]);

  // const participants = useMemo(() => match. ?? [], [match]);

  // const supporters = useMemo(() => {
  //   return participants.filter(
  //     (participant) => participant.role === "SUPPORTER"
  //   );
  // }, [participants]);

  const supporterFollowingAddress = useMemo(() => {
    if (!address) {
      return undefined;
    }

    const supporter = match?.topSupporters.find(
      (participant) =>
        participant.address.toLowerCase() === address.toLowerCase()
    );

    return supporter?.followingAddress ?? undefined;
  }, [address, match?.topSupporters]);

  // WebSocket for real-time copy trade updates
  const {
    allShadowTrades,
    myShadowTrades,
    allOriginalTrades,
    myChadOriginalTrades,
    isConnected: wsConnected,
  } = useMatchEvents({
    matchId,
    userAddress: address,
    followedMonachadAddress: supporterFollowingAddress,
    enabled: match?.status === "ACTIVE", // Only connect when match is active
  });

  const watchingLabel = useMemo(() => {
    if (selectedMonachad) {
      return `${selectedMonachad.slice(0, 8)}…${selectedMonachad.slice(-4)}`;
    }

    if (supporterFollowingAddress) {
      const normalized = supporterFollowingAddress;
      return normalized.length > 12
        ? `${normalized.slice(0, 8)}…${normalized.slice(-4)}`
        : normalized;
    }

    return "Not selected";
  }, [selectedMonachad, supporterFollowingAddress]);

  const matchStatus = match?.status ?? "UNKNOWN";
  const isCreated = matchStatus === "CREATED";
  const isActive = matchStatus === "ACTIVE";
  const isCompleted = matchStatus === "COMPLETED";

  const entryMarginEth = match?.entryMargin
    ? safeFormatEther(match.entryMargin)
    : "0";

  const entryFee = useMemo(() => {
    const base = Number(entryMarginEth);
    if (!Number.isFinite(base)) {
      return 0.0;
    }
    return base * 0.1;
  }, [entryMarginEth]);

  useEffect(() => {
    if (!address || !matchId) {
      setUserParticipant(null);
      return;
    }

    const fetchUserParticipant = async () => {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/matches/${matchId}/participant/${address}`
        );
        if (response.ok) {
          const data = await response.json();
          setUserParticipant(data);
        } else {
          setUserParticipant(null);
        }
      } catch (error) {
        console.error("Failed to fetch user participant", error);
        setUserParticipant(null);
      }
    };

    fetchUserParticipant();
  }, [address, matchId]);

  const userRole = userParticipant?.role ?? null;

  const canStartMatch = useMemo(() => {
    if (!isCreated || userRole !== "MONACHAD") {
      return false;
    }
    if (!match) return false;

    const isCreator = match.creator?.toLowerCase() === address?.toLowerCase();
    const moreThan1Chad = match.monachadCount >= 2;
    return isCreator && moreThan1Chad;
  }, [isCreated, userRole, match?.monachadCount]);

  const allowedDexes = useMemo(() => {
    return match?.allowedDexes ?? [];
  }, [match?.allowedDexes]);

  const handleStartMatch = useCallback(async () => {
    if (!match) {
      return;
    }

    if (!walletClient || !publicClient || !isConnected || !address) {
      setActionError("Connect your wallet before starting the match");
      return;
    }

    const matchManagerAddress = process.env
      .NEXT_PUBLIC_MATCH_MANAGER_ADDRESS as Hex | undefined;

    if (!matchManagerAddress) {
      setActionError("NEXT_PUBLIC_MATCH_MANAGER_ADDRESS is not configured");
      return;
    }

    try {
      setIsStartingMatch(true);
      setActionError(null);

      const normalizedMatchId = BigInt(match.matchId ?? matchId);
      const hash = await walletClient.writeContract({
        address: matchManagerAddress,
        abi: [
          {
            inputs: [
              { internalType: "uint256", name: "_matchId", type: "uint256" },
            ],
            name: "startMatch",
            outputs: [],
            stateMutability: "nonpayable",
            type: "function",
          },
        ],
        functionName: "startMatch",
        args: [normalizedMatchId],
      });

      await publicClient.waitForTransactionReceipt({ hash });
      await fetchMatchDetails();
    } catch (error: any) {
      console.error("Failed to start match", error);
      setActionError(error?.message ?? "Failed to start match");
    } finally {
      setIsStartingMatch(false);
    }
  }, [
    match,
    walletClient,
    publicClient,
    isConnected,
    address,
    fetchMatchDetails,
    matchId,
  ]);

  const joinAsMonachad = useCallback(async () => {
    if (!match || !isCreated) {
      alert("This match is not accepting Monachads right now");
      return;
    }

    if (!walletClient || !publicClient || !isConnected || !address || !chain) {
      alert("Please connect your wallet first");
      return;
    }

    const res = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/smart-account/check-deployment?ownerAddress=${address}`
    );
    const { isDeployed: isSmartAccountDeployed } = await res.json();
    console.log("isSmartAccountDeployed", isSmartAccountDeployed);
    if (!isSmartAccountDeployed) {
      alert("Please complete onboarding to create a smart account");
      router.push("/onboarding");
      return;
    }

    if (!customMargin || Number.parseFloat(customMargin) <= 0) {
      alert("Enter the amount you want to stake");
      return;
    }

    const matchManagerAddress = process.env
      .NEXT_PUBLIC_MATCH_MANAGER_ADDRESS as Hex | undefined;

    if (!matchManagerAddress) {
      alert("NEXT_PUBLIC_MATCH_MANAGER_ADDRESS is not configured");
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!baseUrl) {
      alert("NEXT_PUBLIC_API_URL is not configured");
      return;
    }

    try {
      setIsJoining(true);
      setActionError(null);

      const normalizedMatchId = BigInt(match.matchId ?? matchId);
      const stakeAmount =
        parseEther(customMargin) + parseEther(entryFee.toString());

      const simulation = await publicClient.simulateContract({
        account: address,
        address: matchManagerAddress,
        abi: [
          {
            inputs: [
              { internalType: "uint256", name: "_matchId", type: "uint256" },
            ],
            name: "joinAsMonachad",
            outputs: [],
            stateMutability: "payable",
            type: "function",
          },
        ],
        functionName: "joinAsMonachad",
        args: [normalizedMatchId],
        value: stakeAmount,
      });

      const hash = await walletClient.writeContract(simulation.request);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // await fetch(`${baseUrl}/matches/${matchId}/join-as-monachad`, {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify({
      //     address: address.toLowerCase(),
      //     smartAccountAddress: smartAccountAddr.toLowerCase(),
      //     transactionHash: hash,
      //     blockNumber: Number(receipt.blockNumber),
      //   }),
      // });

      alert(`You are now competing in match #${matchId}!`);
      setJoinMode(null);
      setCustomMargin("");
      await fetchMatchDetails();
    } catch (error: any) {
      console.error("Failed to join match as Monachad", error);

      if (error?.message?.includes("User rejected") || error?.code === 4001) {
        alert("Transaction cancelled");
      } else {
        const friendlyMessage =
          error?.shortMessage ||
          error?.details ||
          error?.message ||
          "Failed to join match";
        setActionError(friendlyMessage);
        alert(friendlyMessage);
      }
    } finally {
      setIsJoining(false);
    }
  }, [
    match,
    isCreated,
    walletClient,
    publicClient,
    isConnected,
    address,
    chain,
    customMargin,
    router,
    fetchMatchDetails,
    matchId,
  ]);

  const followMonachad = useCallback(
    async (monachadAddress: string) => {
      if (!match || (!isCreated && !isActive)) {
        alert("This match is not accepting supporters right now");
        return;
      }

      if (!address || !walletClient || !publicClient || !chain) {
        alert("Please connect your wallet");
        return;
      }

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/smart-account/check-deployment?ownerAddress=${address}`
      );
      const { isDeployed: isSmartAccountDeployed, smartAccountAddress } =
        await res.json();
      console.log("isSmartAccountDeployed", isSmartAccountDeployed);
      if (!isSmartAccountDeployed) {
        alert("Please complete onboarding to create a smart account");
        router.push("/onboarding");
        return;
      }

      if (!customMargin || Number.parseFloat(customMargin) <= 0) {
        alert("Please enter the amount you want to fund your smart account");
        return;
      }

      const matchManagerAddress = process.env
        .NEXT_PUBLIC_MATCH_MANAGER_ADDRESS as Hex | undefined;

      if (!matchManagerAddress) {
        alert("NEXT_PUBLIC_MATCH_MANAGER_ADDRESS is not configured");
        return;
      }

      const tradeClubBundlerAddr =
        process.env.NEXT_PUBLIC_TRADE_CLUB_BUNDLER_ADDRESS;
      if (!tradeClubBundlerAddr) {
        alert("NEXT_PUBLIC_TRADE_CLUB_BUNDLER_ADDRESS is not configured");
        return;
      }

      try {
        setIsJoining(true);
        setSelectedMonachad(monachadAddress);

        const fundingAmount = parseEther(customMargin);
        const entryFeeAmount = parseEther(entryFee.toString());
        const totalAmount = fundingAmount + entryFeeAmount;

        const smartAccount = await toMetaMaskSmartAccount({
          client: publicClient,
          implementation: Implementation.Hybrid,
          address: smartAccountAddress as Hex,
          signer: { walletClient },
        });

        const delegation = createDelegation({
          environment: smartAccount.environment,
          from: smartAccount.address,
          to: tradeClubBundlerAddr as Hex,
          scope: {
            type: "nativeTokenTransferAmount",
            maxAmount: fundingAmount,
          },
          caveats: [],
          salt: `0x${Date.now().toString(16)}`,
        });

        const exactCalldataEnforcer =
          smartAccount.environment?.caveatEnforcers?.ExactCalldataEnforcer;
        const sanitizedDelegation = exactCalldataEnforcer
          ? {
              ...delegation,
              caveats: delegation.caveats.filter((caveat) => {
                if (!caveat || typeof caveat.enforcer !== "string") {
                  return true;
                }
                return (
                  caveat.enforcer.toLowerCase() !==
                  exactCalldataEnforcer.toLowerCase()
                );
              }),
            }
          : delegation;

        if (!sanitizedDelegation.caveats.length) {
          throw new Error(
            "Delegation is missing required caveats after sanitization"
          );
        }

        const signature = await smartAccount.signDelegation({
          delegation: sanitizedDelegation,
          chainId: chain.id,
        });
        const signedDelegation = { ...sanitizedDelegation, signature };

        const hash = await walletClient.writeContract({
          address: matchManagerAddress,
          abi: [
            {
              inputs: [
                { internalType: "uint256", name: "_matchId", type: "uint256" },
                { internalType: "address", name: "_monachad", type: "address" },
                {
                  internalType: "address payable",
                  name: "_smartAccountAddress",
                  type: "address",
                },
              ],
              name: "followMonachadAndFundAccount",
              outputs: [],
              stateMutability: "payable",
              type: "function",
            },
          ],
          functionName: "followMonachadAndFundAccount",
          args: [
            BigInt(match.matchId ?? matchId),
            monachadAddress as Hex,
            smartAccountAddress as Hex,
          ],
          value: totalAmount,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        const baseUrl = process.env.NEXT_PUBLIC_API_URL;
        if (!baseUrl) {
          alert("NEXT_PUBLIC_API_URL is not configured");
          return;
        }
        // Store off-chain signed delegation
        await fetch(`${baseUrl}/matches/${matchId}/delegate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            supporterAddress: address.toLowerCase(),
            monachadAddress: monachadAddress.toLowerCase(),
            smartAccountAddress: smartAccountAddress.toLowerCase(),
            signedDelegation,
            entryFee: entryFeeAmount.toString(),
            fundedAmount: fundingAmount.toString(),
            // transactionHash: hash,
            transactionHash:
              "0x28ea03610c20384ccf363940054b7044aa15d3c85d74b50dc708f0b87d4bf271",
            // blockNumber: Number(receipt.blockNumber),
            blockNumber: 9445419,
          }),
        });

        alert(
          `Successfully following Monachad ${monachadAddress.slice(
            0,
            8
          )}... with ${customMargin} MON!`
        );
        setJoinMode(null);
        setSelectedMonachad(null);
        setCustomMargin("");
        await fetchMatchDetails();
      } catch (error: any) {
        console.error("Failed to follow Monachad", error);

        if (error?.message?.includes("User rejected") || error?.code === 4001) {
          alert("Transaction cancelled");
        } else if (error?.message?.includes("insufficient funds")) {
          alert("Insufficient funds to pay entry fee, funding amount, and gas");
        } else {
          alert(error?.message ?? "Failed to follow Monachad");
        }
      } finally {
        setIsJoining(false);
        setSelectedMonachad(null);
      }
    },
    [
      match,
      isCreated,
      isActive,
      address,
      walletClient,
      publicClient,
      chain,
      customMargin,
      entryFee,
      router,
      fetchMatchDetails,
      matchId,
    ]
  );

  if (loading) {
    return (
      <main className="relative min-h-screen">
        <div className="absolute inset-0 bg-gradient-to-b from-[#080413] via-[#060310] via-30% to-[#04020d] to-black" />
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-purple-500/30 border-t-purple-500" />
        </div>
      </main>
    );
  }

  if (!match) {
    return (
      <main className="relative min-h-screen">
        <div className="absolute inset-0 bg-gradient-to-b from-[#080413] via-[#060310] via-30% to-[#04020d] to-black" />
        <div className="relative z-10 p-8">
          <div className="max-w-6xl mx-auto">
            <div className="bg-black/40 backdrop-blur-md border border-purple-500/20 rounded-2xl p-6 shadow-2xl">
              <p className="text-white/70 mb-4">Match not found</p>
              <Link
                href="/matches"
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                ← Back to Matches
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const leaderboard = match?.topMonachads ?? [];

  return (
    <main className="relative min-h-screen">
      <div className="absolute inset-0 bg-gradient-to-b from-[#080413] via-[#060310] via-30% to-[#04020d] to-black" />
      <div className="relative z-10 p-8">
        <div className="max-w-6xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex justify-between items-center">
            <Link
              href="/matches"
              className="text-purple-400 hover:text-purple-300 transition-colors"
            >
              ← Back to Matches
            </Link>
            <div className="flex items-center gap-3">
              {isRefreshing && (
                <span className="text-xs text-white/50">Refreshing…</span>
              )}
              <button
                onClick={fetchMatchDetails}
                className="px-3 py-1 text-sm rounded-lg border border-purple-500/30 bg-black/40 text-white/70 hover:text-white hover:border-purple-400 transition-all"
              >
                Refresh
              </button>
              <ConnectButton />
            </div>
          </div>

          {/* Error Messages */}
          {loadError && (
            <div className="bg-black/40 backdrop-blur-md border border-red-500/40 rounded-2xl p-6 shadow-2xl bg-red-900/20">
              <p className="font-semibold mb-2 text-red-200">
                Failed to load match
              </p>
              <p className="text-sm text-red-300/70">{loadError}</p>
            </div>
          )}

          {actionError && (
            <div className="bg-black/40 backdrop-blur-md border border-yellow-500/40 rounded-2xl p-6 shadow-2xl bg-yellow-900/20">
              <p className="font-semibold mb-2 text-yellow-200">Heads up</p>
              <p className="text-sm text-yellow-300/70">{actionError}</p>
            </div>
          )}

          {/* Match Header */}
          <div className="bg-black/40 backdrop-blur-md border border-purple-500/20 rounded-2xl p-6 shadow-2xl">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <div>
                <p className="text-sm text-white/50 uppercase tracking-widest mb-1">
                  Match #{match.matchId ?? matchId}
                </p>
                <h1 className="text-3xl font-bold text-purple-300">
                  {getMatchStatusDisplay(matchStatus)}
                </h1>
              </div>
              <span
                className={`px-4 py-2 rounded-full font-semibold text-sm border ${
                  isActive
                    ? "bg-green-500/20 text-green-300 border-green-500/40"
                    : isCreated
                    ? "bg-blue-500/20 text-blue-300 border-blue-500/40"
                    : isCompleted
                    ? "bg-purple-500/20 text-purple-300 border-purple-500/40"
                    : "bg-gray-500/20 text-gray-300 border-gray-500/40"
                }`}
              >
                {matchStatus}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Entry Margin
                </p>
                <p className="text-xl font-semibold text-blue-300">
                  {entryMarginEth} MON
                </p>
              </div>
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Prize Pool
                </p>
                <p className="text-xl font-semibold text-green-300">
                  {safeFormatEther(match.prizePool)} MON
                </p>
              </div>
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Duration
                </p>
                <p className="text-xl font-semibold text-white">
                  {Math.floor((match.duration ?? 0) / 3600)}h
                </p>
              </div>
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Participants
                </p>
                <p className="text-xl font-semibold text-white">
                  {match.participantCount} / {match.maxParticipants}
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 mt-4">
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Supporters
                </p>
                <p className="text-lg font-semibold text-white">
                  {match?.supporterCount}
                </p>
              </div>
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-4">
                <p className="text-xs text-white/50 uppercase tracking-wide mb-1">
                  Creator
                </p>
                <p className="font-mono text-sm text-gray-300">
                  {match.creator ?? "Unknown"}
                </p>
              </div>
            </div>

            {match.startTime && (
              <p className="text-xs text-gray-400 mt-4">
                🕐 Started: {new Date(match.startTime).toLocaleString()}
              </p>
            )}

            {isCreated && userRole === "MONACHAD" && (
              <div className="mt-6 rounded border border-purple-500/30 bg-purple-500/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-purple-200">
                      Monachad Controls
                    </h3>
                    <p className="text-sm text-purple-100/70">
                      Start the match when all traders are ready.
                    </p>
                  </div>
                  <button
                    onClick={handleStartMatch}
                    disabled={!canStartMatch || isStartingMatch}
                    className="px-5 py-2 rounded-lg bg-purple-600 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isStartingMatch ? "Starting…" : "Start Match"}
                  </button>
                </div>
                {!canStartMatch && (
                  <p className="text-xs text-purple-100/60 mt-3">
                    Need at least two Monachads before the match can start.
                  </p>
                )}
              </div>
            )}
          </div>

          {isActive && (
            <div className="space-y-6">
              {/* Trading View - Full Width */}
              {userRole === "MONACHAD" ? (
                <MatchTradingView
                  matchId={match.matchId ?? matchId}
                  allowedDexes={allowedDexes}
                  fundexAddress={fundexAddress}
                  matchManagerAddress={matchManagerAddress}
                  onTradeSuccess={fetchMatchDetails}
                />
              ) : (
                <>
                  <ChartViewOnly matchId={match.matchId ?? matchId} />

                  {/* Battle Feed Panel - Real-time Chaos! */}
                  <BattleFeedPanel
                    allShadowTrades={allShadowTrades}
                    myShadowTrades={myShadowTrades}
                    allOriginalTrades={allOriginalTrades}
                    myChadOriginalTrades={myChadOriginalTrades}
                    isConnected={wsConnected}
                  />
                </>
              )}

              {/* Leaderboard and Stats Section */}
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="card bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-900 border-purple-500/30">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl font-semibold text-white">
                      Live Match Pulse
                    </h2>
                    <span className="px-3 py-1 text-xs font-semibold bg-red-600/20 text-red-300 rounded border border-red-500/40">
                      Broadcasting
                    </span>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-4">
                    {mockChartData.map((point) => (
                      <div key={point.label} className="flex flex-col">
                        <div
                          className="relative flex-1 rounded bg-slate-800 overflow-hidden"
                          style={{ minHeight: "110px" }}
                        >
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-purple-500/70 to-purple-500/10"
                            style={{ height: `${point.value}%` }}
                          />
                        </div>
                        <span className="mt-2 text-xs text-gray-400 text-center">
                          {point.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="card">
                    <h3 className="text-xl font-semibold mb-4">Leaderboard</h3>
                    <div className="space-y-3">
                      {leaderboard.map((entry: any, index: number) => (
                        <button
                          key={entry.address ?? index}
                          onClick={() => openMonachadProfile(entry.address)}
                          className="w-full flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-4 py-3 hover:bg-white/10 hover:border-purple-500/40 transition-all cursor-pointer group"
                        >
                          <div className="flex items-center gap-3">
                            <p className="text-sm text-gray-400">
                              #{index + 1}
                            </p>
                            <div className="text-left">
                              <p className="font-mono text-sm group-hover:text-purple-300 transition-colors">
                                {entry.address?.slice(0, 8)}...
                                {entry.address?.slice(-4)}
                              </p>
                              <p className="text-xs text-gray-500">
                                Click to view profile
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p
                              className={`text-lg font-semibold ${
                                (entry.roi ?? entry.pnl ?? "").startsWith("-")
                                  ? "text-red-400"
                                  : "text-green-400"
                              }`}
                            >
                              {entry.roi ? `${entry.roi}%` : entry.pnl}
                            </p>
                            {entry.pnlEth && (
                              <p className="text-xs text-gray-400">
                                {entry.pnlEth} MON
                              </p>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="card">
                    <h3 className="text-xl font-semibold mb-4">
                      Supporter Feed
                    </h3>
                    {match?.supporterCount === 0 ? (
                      <p className="text-sm text-gray-400">
                        No supporters yet. The crowd is warming up.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {match.topSupporters.slice(0, 5).map((supporter) => (
                          <div
                            key={supporter.address}
                            className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-4 py-3"
                          >
                            <div>
                              <p className="font-mono text-sm">
                                {supporter.address.slice(0, 8)}...
                                {supporter.address.slice(-4)}
                              </p>
                              <p className="text-xs text-gray-500">
                                Following{" "}
                                {supporter.followingAddress?.slice(0, 6)}…
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs text-gray-400">Margin</p>
                              <p className="text-sm font-semibold">
                                {safeFormatEther(
                                  getParticipantStakeWei(supporter)
                                )}{" "}
                                MON
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {isCompleted && (
            <div className="card border-green-500/40 bg-green-500/5">
              <div className="flex flex-col gap-3 text-center">
                <div className="text-5xl">🏁</div>
                <h2 className="text-3xl font-bold text-green-200">
                  Match Finished
                </h2>
                <p className="text-gray-300">
                  {match.winner
                    ? `Winner: ${match.winner}`
                    : "Final results have been recorded."}
                </p>
                <p className="text-sm text-gray-400">
                  Prize Pool: {safeFormatEther(match.prizePool)} MON
                </p>
              </div>
            </div>
          )}

          {isCreated && !joinMode && isConnected && (
            <div className="grid md:grid-cols-2 gap-6">
              <button
                onClick={() => {
                  setJoinMode("monachad");
                  setCustomMargin(safeFormatEther(match.entryMargin));
                }}
                className="card hover:border-blue-500 transition-all text-left p-8"
              >
                <div className="text-4xl mb-4">🎯</div>
                <h3 className="text-2xl font-bold mb-2">Join as Monachad</h3>
                <p className="text-gray-400 mb-4">
                  Compete as a trader. Your plays fuel the broadcast.
                </p>
                <ul className="text-sm text-gray-500 space-y-1">
                  <li>• Stake at least {entryMarginEth} MON</li>
                  <li>• Battle for the prize pool</li>
                  <li>• Attract supporters</li>
                </ul>
                <div className="mt-4 text-blue-400 font-semibold">
                  Continue →
                </div>
              </button>

              <button
                onClick={() => {
                  setJoinMode("supporter");
                  setCustomMargin("");
                }}
                className="card hover:border-purple-500 transition-all text-left p-8"
                disabled={(match?.monachadCount ?? 0) === 0}
              >
                <div className="text-4xl mb-4">👥</div>
                <h3 className="text-2xl font-bold mb-2">Follow a Monachad</h3>
                <p className="text-gray-400 mb-4">
                  Copy their moves with your delegated smart account.
                </p>
                <ul className="text-sm text-gray-500 space-y-1">
                  <li>• Pay {entryFee} MON entry fee</li>
                  <li>• Fund your smart account</li>
                  <li>• Mirror trades automatically</li>
                </ul>
                <div className="mt-4 text-purple-400 font-semibold">
                  {match?.monachadCount ?? 0 === 0
                    ? "Waiting for Monachads..."
                    : "Choose a trader →"}
                </div>
              </button>
            </div>
          )}

          {isCreated && joinMode === "monachad" && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-2xl font-bold">Stake & Compete</h3>
                <button
                  onClick={() => {
                    setJoinMode(null);
                    setCustomMargin("");
                  }}
                  className="text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>

              <p className="text-gray-400 mb-6">
                Minimum stake is {entryMarginEth} MON. Higher stakes increase
                the prize pool and send a signal to supporters.
              </p>

              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Amount to Stake (MON)
                </label>
                <input
                  type="number"
                  step="0.001"
                  min={entryMarginEth}
                  placeholder={`Minimum: ${entryMarginEth} MON`}
                  value={customMargin}
                  onChange={(event) => setCustomMargin(event.target.value)}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500 text-white"
                />
                <p className="text-xs text-gray-500 mt-2">
                  💡 Bigger stakes increase the prize pool and your supporters'
                  confidence.
                </p>
              </div>

              <div className="flex gap-4">
                <button
                  onClick={joinAsMonachad}
                  disabled={
                    isJoining ||
                    !customMargin ||
                    Number.parseFloat(customMargin) <
                      Number.parseFloat(entryMarginEth)
                  }
                  className="btn bg-purple-600 text-white rounded-full px-6 py-2 font-semibold shadow hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isJoining
                    ? "Joining…"
                    : `Join With ${
                        (parseFloat(customMargin) + entryFee).toFixed(4) || "?"
                      } MON`}
                </button>
                <button
                  onClick={() => {
                    setJoinMode(null);
                    setCustomMargin("");
                  }}
                  className="btn border border-gray-400 bg-gray-800 text-gray-200 rounded-full px-6 py-2 font-semibold hover:bg-gray-700 hover:border-gray-500 transition"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {isCreated && joinMode === "supporter" && (
            <div className="space-y-6">
              <div className="card">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-2xl font-bold">Choose a Monachad</h3>
                  <button
                    onClick={() => {
                      setJoinMode(null);
                      setCustomMargin("");
                    }}
                    className="text-gray-400 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>

                <div className="space-y-4">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Entry Fee (10%)</span>
                    <span className="font-semibold">{entryFee} MON</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-gray-400">Smart Account Funding</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      placeholder="e.g., 0.1"
                      value={customMargin}
                      onChange={(event) => setCustomMargin(event.target.value)}
                      className="w-32 px-3 py-1 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-purple-500 text-white text-right"
                    />
                  </div>
                  <div className="border-t border-gray-700 pt-3 flex justify-between text-lg font-bold">
                    <span>Total Commitment</span>
                    <span className="text-purple-400">
                      {customMargin
                        ? (
                            Number.parseFloat(entryFee.toString()) +
                            Number.parseFloat(customMargin)
                          ).toFixed(4)
                        : entryFee}{" "}
                      MON
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Entry fee goes to the prize pool. Funding amount fuels your
                    smart account for mirrored trades.
                  </p>
                </div>
              </div>

              {match?.monachadCount === 0 ? (
                <div className="card">
                  <p className="text-gray-400">
                    No Monachads competing yet. Be the first to join!
                  </p>
                </div>
              ) : (
                <div className="grid md:grid-cols-2 gap-6">
                  {match?.topMonachads.map((monachad) => (
                    <div
                      key={monachad.address}
                      className="card hover:border-purple-500 transition-all"
                    >
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <p className="text-sm text-gray-500">Monachad</p>
                          <p className="font-mono text-lg font-bold">
                            {monachad.address.slice(0, 6)}...
                            {monachad.address.slice(-4)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-500">ROI</p>
                          <p
                            className={`text-2xl font-bold ${
                              Number.parseFloat(
                                // TODO: correct calculation
                                calculateRoi(
                                  monachad.pnl,
                                  getParticipantStakeWei(monachad)
                                )
                              ) >= 0
                                ? "text-green-400"
                                : "text-red-400"
                            }`}
                          >
                            {calculateRoi(
                              monachad.pnl,
                              getParticipantStakeWei(monachad)
                            )}
                            %
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
                        <div>
                          <p className="text-gray-500">Staked</p>
                          <p>
                            {safeFormatEther(getParticipantStakeWei(monachad))}{" "}
                            MON
                          </p>
                        </div>
                        <div>
                          <p className="text-gray-500">PnL</p>
                          <p
                            className={
                              (monachad.pnl ?? "0").startsWith("-")
                                ? "text-red-400"
                                : "text-green-400"
                            }
                          >
                            {monachad.pnl} MON
                          </p>
                        </div>
                      </div>

                      <button
                        onClick={() => followMonachad(monachad.address)}
                        disabled={
                          (isJoining &&
                            selectedMonachad === monachad.address) ||
                          !customMargin ||
                          Number.parseFloat(customMargin) <= 0
                        }
                        className={`btn w-full rounded-lg font-semibold text-white px-6 py-3 transition-all
                            bg-gradient-to-r from-purple-600 via-purple-500 to-purple-700
                            shadow-lg shadow-purple-900/20
                            hover:from-purple-700 hover:to-purple-800 hover:scale-[1.03]
                            disabled:opacity-50 disabled:cursor-not-allowed`}
                        style={{
                          boxShadow: "0 2px 8px 0 rgba(128, 90, 213, 0.15)",
                          fontSize: "1.1rem",
                          letterSpacing: "0.02em",
                        }}
                      >
                        {isJoining && selectedMonachad === monachad.address ? (
                          "Following…"
                        ) : (
                          <>Follow This Monachad</>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!joinMode && match?.monachadCount > 0 && !isActive && (
            <div className="card">
              <h3 className="text-2xl font-bold mb-4">Competing Monachads</h3>
              <div className="space-y-4">
                {match?.topMonachads.map((monachad, index) => (
                  <button
                    key={monachad.address}
                    onClick={() => openMonachadProfile(monachad.address)}
                    className="w-full flex items-center justify-between p-4 bg-gray-800/50 rounded-lg hover:bg-gray-800/80 hover:border hover:border-purple-500/40 transition-all cursor-pointer group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="text-2xl font-bold text-gray-500">
                        #{index + 1}
                      </div>
                      <div className="text-left">
                        <p className="font-mono font-semibold group-hover:text-purple-300 transition-colors">
                          {monachad.address.slice(0, 8)}...
                          {monachad.address.slice(-6)}
                        </p>
                        <p className="text-sm text-gray-500">
                          {monachad.joinedAt
                            ? new Date(monachad.joinedAt).toLocaleDateString()
                            : "Click to view profile"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-8">
                      <div className="text-right">
                        <p className="text-sm text-gray-500">PnL</p>
                        <p
                          className={`font-bold ${
                            (monachad.pnl ?? "0").startsWith("-")
                              ? "text-red-400"
                              : "text-green-400"
                          }`}
                        >
                          {monachad.pnl} MON
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-gray-500">ROI</p>
                        <p
                          className={`text-xl font-bold ${
                            Number.parseFloat(
                              calculateRoi(
                                monachad.pnl,
                                getParticipantStakeWei(monachad)
                              )
                            ) >= 0
                              ? "text-green-400"
                              : "text-red-400"
                          }`}
                        >
                          {Number.parseFloat(
                            calculateRoi(
                              monachad.pnl,
                              getParticipantStakeWei(monachad)
                            )
                          )}
                          %
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Monachad Profile Modal */}
      {selectedProfileAddress && (
        <MonachadProfileModal
          address={selectedProfileAddress}
          isOpen={profileModalOpen}
          onClose={closeMonachadProfile}
        />
      )}
    </main>
  );
}
