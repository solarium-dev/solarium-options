use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked},
};

use crate::error::ErrorCode;
use crate::state::CoveredCall;

#[derive(Accounts)]
#[instruction(amount_base: u64, amount_quote: u64, timestamp_expiry: i64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub buyer: SystemAccount<'info>,
    #[account(
        init,
        payer = seller,
        space = 8 + CoveredCall::INIT_SPACE,
        seeds = [
            b"covered-call",
            seller.key().as_ref(),
            buyer.key().as_ref(),
            mint_base.key().as_ref(),
            mint_quote.key().as_ref(),
            amount_base.to_le_bytes().as_ref(),
            amount_quote.to_le_bytes().as_ref(),
            timestamp_expiry.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub data: Account<'info, CoveredCall>,
    pub mint_base: Account<'info, Mint>,
    pub mint_quote: Account<'info, Mint>,
    #[account(
        mut,
        constraint = ata_seller_base.amount >= amount_base,
        associated_token::mint = mint_base,
        associated_token::authority = seller,
    )]
    pub ata_seller_base: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = seller,
        associated_token::mint = mint_base,
        associated_token::authority = data,
    )]
    pub ata_vault_base: Account<'info, TokenAccount>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(
    ctx: Context<Initialize>,
    amount_base: u64,
    amount_quote: u64,
    timestamp_expiry: i64,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(
        timestamp_expiry > clock.unix_timestamp,
        ErrorCode::ExpiryIsInThePast
    );

    // Set state
    ctx.accounts.data.set_inner(CoveredCall {
        amount_base,
        amount_premium: None,
        amount_quote,
        bump: ctx.bumps.data,
        buyer: ctx.accounts.buyer.key(),
        is_exercised: false,
        mint_base: ctx.accounts.mint_base.key(),
        mint_quote: ctx.accounts.mint_quote.key(),
        seller: ctx.accounts.seller.key(),
        timestamp_created: clock.unix_timestamp,
        timestamp_expiry,
    });

    // Transfer base to vault
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.ata_seller_base.to_account_info(),
                to: ctx.accounts.ata_vault_base.to_account_info(),
                mint: ctx.accounts.mint_base.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        amount_base,
        ctx.accounts.mint_base.decimals,
    )?;

    Ok(())
}
