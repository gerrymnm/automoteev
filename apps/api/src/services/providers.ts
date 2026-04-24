export interface ProviderInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  provider_type: string;
  location?: string | null;
}

export async function findProviders(params: {
  providerType: string;
  zipCode?: string | null;
}): Promise<ProviderInput[]> {
  return [
    {
      name: `Manual ${params.providerType} provider`,
      provider_type: params.providerType,
      location: params.zipCode ?? "Owner location"
    }
  ];
}
