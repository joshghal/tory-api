/**
 * Known exchange hot wallet addresses (lowercase).
 * Source: Etherscan labels + public documentation.
 * Used for exchange flow detection in on-chain analysis.
 */

export const EXCHANGE_ADDRESSES: Record<string, string> = {
  // Binance
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance',
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f': 'Binance',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0x5a52e96bacdabb82fd05763e25335261b270efcb': 'Binance',
  '0x835678a611b28684005a5e2233695fb6cbbb0007': 'Binance',
  '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8': 'Binance',
  '0x3c783c21a0383057d128bae431894a5c19f9cf06': 'Binance',
  '0xb38e8c17e38363af6ebdcb3dae12e0243582891d': 'Binance',

  // Coinbase
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase',
  '0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740': 'Coinbase',
  '0x3cd751e6b0078be393132286c442345e68ff0aaa': 'Coinbase',
  '0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511': 'Coinbase',
  '0xeb2629a2734e272bcc07bda959863f316f4bd4cf': 'Coinbase',

  // OKX
  '0x5041ed759dd4afc3a72b8192c143f72f4724081a': 'OKX',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX',
  '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3': 'OKX',
  '0xa7efae728d2936e78bda97dc267687568dd593f3': 'OKX',

  // Kraken
  '0x46340b20830761efd32832a74d7169b29feb9758': 'Kraken',
  '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0': 'Kraken',
  '0xfa52274dd61e1643d2205169732f29114bc240b3': 'Kraken',
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2': 'Kraken',
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13': 'Kraken',

  // Bybit
  '0x1ab4973a48dc892cd9971ece8e01dcc7688f8f23': 'Bybit',
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': 'Bybit',

  // KuCoin
  '0xd6216fc19db775df9774a6e33526131da7d19a2c': 'KuCoin',
  '0x1692e170361cefd1eb7240ec13d048fd9af6d667': 'KuCoin',

  // Gate.io
  '0xa83b11093c163c3f79cc3fe01e5d9d9e8b07e11e': 'Gate.io',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c': 'Gate.io',

  // Bitfinex
  '0x876eabf441b2ee5b5b0554fd502a8e0600950cfa': 'Bitfinex',
  '0x742d35cc6634c0532925a3b844bc9e7595f2bd1e': 'Bitfinex',
  '0x1151314c646ce4e0efd76d1af4760ae66a9fe30f': 'Bitfinex',

  // Gemini
  '0xd24400ae8bfebb18ca49be86258a3c749cf46853': 'Gemini',
  '0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8': 'Gemini',

  // Huobi / HTX
  '0xab5c66752a9e8167967685f1450532fb96d5d24f': 'HTX',
  '0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b': 'HTX',
  '0xfdb16996831753d5331ff813c29a93c76834a0ad': 'HTX',
  '0xeee28d484628d41a82d01a21dc9944050360602c': 'HTX',

  // Crypto.com
  '0x6262998ced04146fa42253a5c0af90ca02dfd2a3': 'Crypto.com',
  '0xcffad3200574698b78f32232aa9d63eabd290703': 'Crypto.com',

  // Upbit
  '0x390de26d772d2e2005c6d1d24afc902bae37a4bb': 'Upbit',
  '0xba826fec90cefdf6706858e5fbafcb27a290fbe0': 'Upbit',
  '0x5e032243d507c743b061ef021e2ec7fcc6d3ab89': 'Upbit',
};

// Dead/burn addresses
export const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001',
  '0xdead000000000000000000000000000000000000',
]);

// Quick lookup set for exchange detection
export const EXCHANGE_SET = new Set(Object.keys(EXCHANGE_ADDRESSES));
