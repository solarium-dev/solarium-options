import { describe, it, expect } from "vitest";
import {
  startAnchor,
  BanksClient,
  ProgramTestContext,
  Clock,
} from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import * as anchor from "@coral-xyz/anchor";
import * as token from "@solana/spl-token";
import { Program } from "@coral-xyz/anchor";
import { SolanaOptions } from "../target/types/solana_options.js";
import IDL from "../target/idl/solana_options.json";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "spl-token-bankrun";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Signer } from "@solana/web3.js";

const authority = anchor.web3.Keypair.generate();
async function getAtaTokenBalance(
  client: BanksClient,
  mint: PublicKey,
  user: PublicKey
) {
  const ata = token.getAssociatedTokenAddressSync(mint, user, true);

  return (await getAccount(client, ata)).amount;
}

// From https://github.com/kevinheavey/solana-bankrun/issues/3#issuecomment-2211797870
async function airdrop(
  context: ProgramTestContext,
  user: PublicKey,
  lamports: bigint | number
) {
  const accountInfo = await context.banksClient.getAccount(user);
  const newBalance =
    BigInt(accountInfo ? accountInfo.lamports : 0) + BigInt(lamports);

  context.setAccount(user, {
    lamports: Number(newBalance),
    data: Buffer.alloc(0),
    owner: PublicKey.default,
    executable: false,
  });
}

async function fundAtaAccount(
  client: BanksClient,
  mint: PublicKey,
  signer: Signer,
  amount: bigint | number
) {
  const payer = signer;
  const user = signer.publicKey;

  const ata = await createAssociatedTokenAccount(client, payer, mint, user);

  await mintTo(client, payer, mint, ata, authority, amount);
}

const fixtureDeployed = async () => {
  const context = await startAnchor(".", [], []);
  const provider = new BankrunProvider(context);

  // @ts-ignore
  const program = new Program<SolanaOptions>(IDL, provider);

  const seller = context.payer;
  const buyer = Keypair.generate();

  await airdrop(context, buyer.publicKey, 1 * LAMPORTS_PER_SOL);

  const [wsol, usdc] = await Promise.all([
    createMint(
      context.banksClient,
      context.payer,
      authority.publicKey,
      authority.publicKey,
      9
    ),
    createMint(
      context.banksClient,
      context.payer,
      authority.publicKey,
      authority.publicKey,
      6
    ),
  ]);

  await Promise.all([
    fundAtaAccount(context.banksClient, wsol, seller, BigInt(1000)),
    fundAtaAccount(context.banksClient, wsol, buyer, BigInt(1000)),
  ]);

  const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("covered-call"), context.payer.publicKey.toBuffer()],
    program.programId
  );

  return {
    context,
    program,
    provider,
    pda,
    wsol,
    seller,
    usdc,
    buyer,
  };
};
expect.extend({
  toBeBN: (actual: anchor.BN, expected: anchor.BN) => {
    return {
      pass: actual.eq(expected),
      message: () => `expected ${expected} to be ${actual}`,
      actual: actual.toString(),
      expected: expected.toString(),
    };
  },
});

describe("solana-options", () => {
  describe("initialize instruction", () => {
    it("Can initialize option", async () => {
      const { context, program, pda, wsol, seller, usdc, buyer } =
        await fixtureDeployed();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, seller.publicKey)
      ).to.equal(BigInt(1000));

      const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 60);
      const tx = await program.methods
        .initialize(
          new anchor.BN("1000"),
          new anchor.BN(1),
          new anchor.BN(expiry)
        )
        .accounts({
          mintUnderlying: wsol,
          mintQuote: usdc,
          buyer: buyer.publicKey,
        })
        .rpc();

      // Check state
      expect(await program.account.coveredCall.fetch(pda)).toStrictEqual({
        amountPremium: null,
        amountQuote: expect.toBeBN(new anchor.BN(1)),
        amountUnderlying: expect.toBeBN(new anchor.BN(1000)),
        buyer: buyer.publicKey,
        expiryUnixTimestamp: expect.toBeBN(expiry),
        mintQuote: usdc,
        mintUnderlying: wsol,
        seller: context.payer.publicKey,
        bump: expect.any(Number),
      });

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, seller.publicKey)
      ).to.equal(BigInt(0));

      expect(await getAtaTokenBalance(context.banksClient, wsol, pda)).to.equal(
        BigInt(1000)
      );
    });

    it.skip("Can mint same option twice ", async () => {
      const { context, program, pda, wsol, seller, usdc, buyer } =
        await fixtureDeployed();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, seller.publicKey)
      ).to.equal(BigInt(1000));

      const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 60);
      await program.methods
        .initialize(
          new anchor.BN("500"),
          new anchor.BN(1),
          new anchor.BN(expiry)
        )
        .accounts({
          mintUnderlying: wsol,
          mintQuote: usdc,
          buyer: buyer.publicKey,
        })
        .rpc();

      await program.methods
        .initialize(
          new anchor.BN("500"),
          new anchor.BN(1),
          new anchor.BN(expiry)
        )
        .accounts({
          mintUnderlying: wsol,
          mintQuote: usdc,
          buyer: buyer.publicKey,
        })
        .rpc();
    });

    it("Can reject initialize with expiry in the past", async () => {
      const { context, program, wsol, seller, usdc, buyer } =
        await fixtureDeployed();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, seller.publicKey)
      ).to.equal(BigInt(1000));

      await expect(
        program.methods
          .initialize(
            new anchor.BN("1000"),
            new anchor.BN(1),
            new anchor.BN(Math.floor(Date.now() / 1000) - 600)
          )
          .accounts({
            mintUnderlying: wsol,
            mintQuote: usdc,
            buyer: buyer.publicKey,
          })
          .rpc()
      ).rejects.toThrowError(
        /^AnchorError thrown in programs\/solana-options\/src\/instructions\/initialize.rs:\d+. Error Code: ExpiryIsInThePast. Error Number: 6000. Error Message: Expiry is in the past.$/
      );
    });
    it("Can reject initialize with insufficient underlying", async () => {
      const { context, program, wsol, seller, usdc, buyer } =
        await fixtureDeployed();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, seller.publicKey)
      ).to.equal(BigInt(1000));

      await expect(
        program.methods
          .initialize(
            new anchor.BN("10000"),
            new anchor.BN(1),
            new anchor.BN(Math.floor(Date.now() / 1000) + 60)
          )
          .accounts({
            mintUnderlying: wsol,
            mintQuote: usdc,
            buyer: buyer.publicKey,
          })
          .rpc()
      ).rejects.toThrowError(
        "AnchorError caused by account: ata_seller_underlying. Error Code: ConstraintRaw. Error Number: 2003. Error Message: A raw constraint was violated."
      );
    });
  });

  describe("Buy instruction", () => {
    const fixtureInitialized = async () => {
      const fixture = await fixtureDeployed();
      const { program, wsol, usdc, buyer } = fixture;
      const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 60);
      await program.methods
        .initialize(
          new anchor.BN("1000"),
          new anchor.BN(1),
          new anchor.BN(expiry)
        )
        .accounts({
          mintUnderlying: wsol,
          mintQuote: usdc,
          buyer: buyer.publicKey,
        })
        .rpc();

      return {
        expiry,
        ...fixture,
      };
    };

    it("Can successfully buy ", async () => {
      const { program, pda, seller, buyer, wsol, context, expiry, usdc } =
        await fixtureInitialized();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, buyer.publicKey)
      ).to.equal(BigInt(1000));

      await program.methods
        .buy(new anchor.BN(10))
        .accounts({
          data: pda,
          buyer: buyer.publicKey,
          mintPremium: wsol,
        })
        .signers([buyer])
        .rpc();

      // Check state
      expect(await program.account.coveredCall.fetch(pda)).toStrictEqual({
        amountQuote: expect.toBeBN(new anchor.BN(1)),
        amountUnderlying: expect.toBeBN(new anchor.BN(1000)),
        amountPremium: expect.toBeBN(new anchor.BN(10)),
        buyer: buyer.publicKey,
        expiryUnixTimestamp: expect.toBeBN(expiry),
        mintQuote: usdc,
        mintUnderlying: wsol,
        seller: context.payer.publicKey,
        bump: expect.any(Number),
      });

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, buyer.publicKey)
      ).to.equal(BigInt(990));

      expect(await getAtaTokenBalance(context.banksClient, wsol, pda)).to.equal(
        BigInt(1010)
      );
    });

    it("Can reject if option has already been bought", async () => {
      const { program, pda, buyer, wsol, context, expiry } =
        await fixtureInitialized();

      await program.methods
        .buy(new anchor.BN(10))
        .accounts({
          data: pda,
          buyer: buyer.publicKey,
          mintPremium: wsol,
        })
        .signers([buyer])
        .rpc();

      // Wait to avoid getting the error "This transaction has already been processed"
      await new Promise((resolve) => setTimeout(resolve, 1));

      await expect(
        program.methods
          .buy(new anchor.BN(10))
          .accounts({
            data: pda,
            buyer: buyer.publicKey,
            mintPremium: wsol,
          })
          .signers([buyer])
          .rpc()
      ).rejects.toThrowError(
        /AnchorError thrown in programs\/solana-options\/src\/instructions\/buy.rs:\d\d. Error Code: OptionAlreadyBought. Error Number: 6002. Error Message: Option is already bought./
      );
    });

    it("Can reject if option is expired", async () => {
      const { program, pda, buyer, wsol, context, expiry } =
        await fixtureInitialized();

      // Lets warp past the expiry
      const currentClock = await context.banksClient.getClock();
      context.setClock(
        new Clock(
          currentClock.slot,
          currentClock.epochStartTimestamp,
          currentClock.epoch,
          currentClock.leaderScheduleEpoch,
          BigInt(expiry.toNumber() + 100)
        )
      );

      await expect(
        program.methods
          .buy(new anchor.BN(10))
          .accounts({
            data: pda,
            buyer: buyer.publicKey,
            mintPremium: wsol,
          })
          .signers([buyer])
          .rpc()
      ).rejects.toThrowError(
        /AnchorError thrown in programs\/solana-options\/src\/instructions\/buy.rs:\d\d. Error Code: OptionExpired. Error Number: 6001. Error Message: Option has expired./
      );
    });

    it("Can reject buy if premium is not in underlying", async () => {
      const { program, pda, seller, buyer, wsol, context, usdc } =
        await fixtureInitialized();

      await fundAtaAccount(context.banksClient, usdc, buyer, BigInt(500));

      expect(
        await getAtaTokenBalance(context.banksClient, usdc, buyer.publicKey)
      ).to.equal(BigInt(500));

      await expect(
        program.methods
          .buy(new anchor.BN(500))
          .accounts({
            data: pda,
            buyer: buyer.publicKey,
            mintPremium: usdc,
          })
          .signers([buyer])
          .rpc()
      ).rejects.toThrowError(
        "AnchorError caused by account: ata_vault_premium. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized."
      );

      // Also test when ata is initialized
      await createAssociatedTokenAccount(context.banksClient, buyer, usdc, pda);
      await expect(
        program.methods
          .buy(new anchor.BN(500))
          .accounts({
            data: pda,
            buyer: buyer.publicKey,
            mintPremium: usdc,
          })
          .signers([buyer])
          .rpc()
      ).rejects.toThrowError(
        "AnchorError caused by account: mint_premium. Error Code: ConstraintRaw. Error Number: 2003. Error Message: A raw constraint was violated."
      );
    });

    it("Can reject if buyer has insufficient funds", async () => {
      const { program, pda, buyer, wsol, context } = await fixtureInitialized();

      expect(
        await getAtaTokenBalance(context.banksClient, wsol, buyer.publicKey)
      ).to.equal(BigInt(1000));
      await expect(
        program.methods
          .buy(new anchor.BN(2000))
          .accounts({
            data: pda,
            buyer: buyer.publicKey,
            mintPremium: wsol,
          })
          .signers([buyer])
          .rpc()
      ).rejects.toThrowError(
        "AnchorError caused by account: ata_buyer_premium. Error Code: ConstraintRaw. Error Number: 2003. Error Message: A raw constraint was violated."
      );
    });

    it("Can reject if not buyer", async () => {
      const { program, pda, seller, wsol } = await fixtureInitialized();

      await expect(
        program.methods
          .buy(new anchor.BN(1))
          .accounts({
            data: pda,
            buyer: seller.publicKey,
            mintPremium: wsol,
          })
          .signers([seller])
          .rpc()
      ).rejects.toThrowError(
        "AnchorError caused by account: buyer. Error Code: ConstraintRaw. Error Number: 2003. Error Message: A raw constraint was violated"
      );
    });
  });
});
