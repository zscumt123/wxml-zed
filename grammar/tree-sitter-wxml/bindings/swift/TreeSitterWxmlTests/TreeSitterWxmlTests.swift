import XCTest
import SwiftTreeSitter
import TreeSitterWxml

final class TreeSitterWxmlTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_wxml())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading WeiXin Markup Language grammar")
    }
}
