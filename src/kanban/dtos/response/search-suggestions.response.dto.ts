export class SearchSuggestionResponseDto {
  type: 'contact' | 'keyword' | 'subject';
  text: string;
  value: string;

  static fromSuggestion(suggestion: any): SearchSuggestionResponseDto {
    return {
      type: suggestion.type,
      text: suggestion.text,
      value: suggestion.value,
    };
  }
}

export class SearchSuggestionsResponseDto {
  results: SearchSuggestionResponseDto[];

  static create(suggestions: any[]): SearchSuggestionsResponseDto {
    return {
      results: (suggestions ?? []).map((s) =>
        SearchSuggestionResponseDto.fromSuggestion(s),
      ),
    };
  }
}
