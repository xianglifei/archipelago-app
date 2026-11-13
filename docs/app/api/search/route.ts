import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

export const revalidate = false;

// 不传 language:默认 multilingual 分词,中文召回靠它。
// 模板默认的 language: 'english' 会把中文查询切坏(BM25 召回明显下降)。
export const { staticGET: GET } = createFromSource(source);
