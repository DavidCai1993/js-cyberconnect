import { CeramicClient } from '@ceramicnetwork/http-client';
import KeyDidResolver from 'key-did-resolver';
import ThreeIdResolver from '@ceramicnetwork/3id-did-resolver';
import ThreeIdProvider from '3id-did-provider';
import { EthereumAuthProvider } from '@3id/connect';
import {
  SolanaAuthProvider,
  solana,
} from '@ceramicnetwork/blockchain-utils-linking';
import { hash } from '@stablelib/sha256';
import { fromString } from 'uint8arrays';
import { DID } from 'dids';
import { IDX } from '@ceramicstudio/idx';
import { endpoints } from './network';
import { follow, unfollow, setAlias } from './queries';
import { ConnectError, ErrorCode } from './error';
import { Endpoint, Blockchain, CyberConnetStore, Config } from './types';
import { getAddressByProvider } from './utils';
import { Env } from '.';

class CyberConnect {
  address: string = '';
  namespace: string;
  endpoint: Endpoint;
  ceramicClient: CeramicClient;
  authProvider: EthereumAuthProvider | SolanaAuthProvider | undefined;
  resolverRegistry: any;
  idxInstance: IDX | undefined;
  signature: string = '';
  chain: Blockchain = Blockchain.ETH;
  chainRef: string = '';
  provider: any = null;

  constructor(config: Config) {
    const { provider, namespace, env, chainRef, chain } = config;

    if (!namespace) {
      throw new ConnectError(ErrorCode.EmptyNamespace);
    }

    this.namespace = namespace;
    this.endpoint = endpoints[env || Env.PRODUCTION];
    this.ceramicClient = new CeramicClient(this.endpoint.ceramicUrl);
    this.chain = chain || Blockchain.ETH;
    this.chainRef = chainRef || '';
    this.provider = provider;

    const keyDidResolver = KeyDidResolver.getResolver();
    const threeIdResolver = ThreeIdResolver.getResolver(this.ceramicClient);

    this.resolverRegistry = {
      ...threeIdResolver,
      ...keyDidResolver,
    };
  }

  async getAuthProvider() {
    if (!this.provider) {
      throw new ConnectError(ErrorCode.EmptyEthProvider);
    }

    try {
      this.address = await getAddressByProvider(this.provider, this.chain);
    } catch (e) {
      throw new ConnectError(ErrorCode.AuthProviderError, e as string);
    }

    switch (this.chain) {
      case Blockchain.ETH: {
        this.authProvider = new EthereumAuthProvider(
          this.provider,
          this.address
        );
        break;
      }
      case Blockchain.SOLANA: {
        if (!this.provider.publicKey) {
          throw new ConnectError(
            ErrorCode.AuthProviderError,
            'Wallet Not Connected'
          );
        }
        if (!this.provider.signMessage) {
          throw new ConnectError(
            ErrorCode.AuthProviderError,
            'Provider must implement signMessage'
          );
        }

        this.authProvider = new SolanaAuthProvider(
          this.provider,
          this.address,
          this.chainRef
        );

        break;
      }
    }
  }

  async authenticate() {
    if (this.signature) {
      return;
    }

    await this.getAuthProvider();

    if (!this.authProvider) {
      throw new ConnectError(ErrorCode.EmptyAuthProvider);
    }

    const rst = await this.authProvider.authenticate(
      'Allow this account to control your identity'
    );
    this.signature = rst;
  }

  private async setupIdx() {
    if (this.idxInstance) {
      return;
    }

    if (!this.authProvider) {
      new ConnectError(ErrorCode.EmptyAuthProvider).printError();
      return;
    }

    if (!this.ceramicClient) {
      new ConnectError(
        ErrorCode.CeramicError,
        'Can not find ceramic client'
      ).printError();
      return;
    }

    const getPermission = async (request: any) => {
      return request.payload.paths;
    };

    const authSecret = hash(fromString(this.signature.slice(2)));
    const authId = (await this.authProvider.accountId()).toString();

    const threeId = await ThreeIdProvider.create({
      getPermission,
      authSecret,
      authId,
      ceramic: this.ceramicClient,
    });

    const threeIdProvider = threeId.getDidProvider();
    const did = new DID({
      provider: threeIdProvider,
      resolver: this.resolverRegistry,
    });

    await did.authenticate();
    await this.ceramicClient.setDID(did);

    this.idxInstance = new IDX({
      ceramic: this.ceramicClient,
      aliases: {
        cyberConnect: this.endpoint.cyberConnectSchema,
      },
      autopin: true,
    });
  }

  async getOutboundLink() {
    if (!this.idxInstance) {
      throw new ConnectError(
        ErrorCode.CeramicError,
        'Could not find idx instance'
      );
    }

    const result = (await this.idxInstance.get(
      'cyberConnect'
    )) as CyberConnetStore;

    return result?.outboundLink || null;
  }

  private async ceramicConnect(targetAddr: string, alias: string = '') {
    try {
      await this.setupIdx();

      const outboundLink = await this.getOutboundLink();

      if (!outboundLink) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Can not get ceramic outboundLink'
        );
      }

      if (!this.idxInstance) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Could not find idx instance'
        );
      }

      const link = outboundLink.find((link) => {
        return link.target === targetAddr && link.namespace === this.namespace;
      });

      if (!link) {
        const curTimeStr = String(Date.now());
        outboundLink.push({
          target: targetAddr,
          connectionType: 'follow',
          namespace: this.namespace,
          alias,
          createdAt: curTimeStr,
        });
        this.idxInstance.set('cyberConnect', { outboundLink });
      } else {
        console.warn('You have already connected to the target address');
      }
    } catch (e) {
      console.error(e);
    }
  }

  private async ceramicDisconnect(targetAddr: string) {
    try {
      await this.setupIdx();

      const outboundLink = await this.getOutboundLink();

      if (!outboundLink) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Can not get ceramic outboundLink'
        );
      }

      if (!this.idxInstance) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Could not find idx instance'
        );
      }

      const newOutboundLink = outboundLink.filter((link) => {
        return link.target !== targetAddr || link.namespace !== this.namespace;
      });

      this.idxInstance.set('cyberConnect', {
        outboundLink: newOutboundLink,
      });
    } catch (e) {
      console.error(e);
    }
  }

  private async ceramicSetAlias(targetAddr: string, alias: string) {
    try {
      await this.setupIdx();

      const outboundLink = await this.getOutboundLink();

      if (!outboundLink) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Can not get ceramic outboundLink'
        );
      }

      if (!this.idxInstance) {
        throw new ConnectError(
          ErrorCode.CeramicError,
          'Could not find idx instance'
        );
      }

      const index = outboundLink.findIndex((link) => {
        return link.target === targetAddr && link.namespace === this.namespace;
      });

      if (index !== -1) {
        outboundLink[index] = { ...outboundLink[index], alias };
        this.idxInstance.set('cyberConnect', { outboundLink });
      } else {
        throw new ConnectError(
          ErrorCode.CeramicError,
          "Couldn't find the target address in the given namespace"
        );
      }
    } catch (e) {
      console.log(e);
    }
  }

  async connect(targetAddr: string, alias: string = '') {
    await this.authenticate();

    try {
      const resp = await follow({
        fromAddr: this.address,
        toAddr: targetAddr,
        alias,
        namespace: this.namespace,
        url: this.endpoint.cyberConnectApi,
        signature: this.signature,
      });

      if (resp?.data?.follow.result !== 'SUCCESS') {
        throw new ConnectError(
          ErrorCode.GraphqlError,
          resp?.data?.follow.result
        );
      }

      console.log('Connect success');
    } catch (e: any) {
      throw new ConnectError(ErrorCode.GraphqlError, e.message || e);
    }

    this.ceramicConnect(targetAddr, alias);
  }

  async disconnect(targetAddr: string) {
    await this.authenticate();

    try {
      const resp = await unfollow({
        fromAddr: this.address,
        toAddr: targetAddr,
        url: this.endpoint.cyberConnectApi,
        namespace: this.namespace,
        signature: this.signature,
      });

      if (resp?.data?.unfollow.result !== 'SUCCESS') {
        throw new ConnectError(
          ErrorCode.GraphqlError,
          resp?.data?.unfollow.result
        );
      }

      console.log('Disconnect success');
    } catch (e: any) {
      throw new ConnectError(ErrorCode.GraphqlError, e.message || e);
    }

    this.ceramicDisconnect(targetAddr);
  }

  async setAlias(targetAddr: string, alias: string) {
    await this.authenticate();

    try {
      const resp = await setAlias({
        fromAddr: this.address,
        toAddr: targetAddr,
        url: this.endpoint.cyberConnectApi,
        namespace: this.namespace,
        signature: this.signature,
        alias,
      });

      if (resp?.data?.setAlias.result !== 'SUCCESS') {
        throw new ConnectError(
          ErrorCode.GraphqlError,
          resp?.data?.setAlias.result
        );
      }

      console.log('Set alias success');
    } catch (e: any) {
      throw new ConnectError(ErrorCode.GraphqlError, e.message || e);
    }

    this.ceramicSetAlias(targetAddr, alias);
  }
}

export default CyberConnect;
